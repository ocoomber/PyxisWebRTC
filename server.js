const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');

// ffmpeg binary location (must be ffmpeg >= 8.x with the native WHIP muxer).
// Override with $env:FFMPEG if it is not on PATH.
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// mediaMTX: local single-exe WebRTC(WHIP-in/WHEP-out) server
const MEDIAMTX = process.env.MEDIAMTX
  || path.join(__dirname, 'mediamtx', 'mediamtx.exe');
const MEDIAMTX_HTTP_PORT = 8889;   // WHIP/WHEP HTTP
const MEDIAMTX_UDP_PORT = 8189;    // WebRTC media plane
const WHIP_URL = 'http://127.0.0.1:' + MEDIAMTX_HTTP_PORT + '/live/whip';

// camera REST access (basic auth over HTTPS)
const CAMERA_HOST = process.env.CAMERA || '';
const CAMERA_USER = process.env.CAMERA_USER || '';
const CAMERA_PASS = process.env.CAMERA_PASS || '';
const CAMERA_AUTH = 'Basic ' + Buffer.from(CAMERA_USER + ':' + CAMERA_PASS).toString('base64');
const CAMERA_API = 'https://' + CAMERA_HOST + '/control/api/v1';

function proxyCamera(req, res, camPath) {
  if (!CAMERA_HOST || !CAMERA_USER || !CAMERA_PASS) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('CAMERA, CAMERA_USER and CAMERA_PASS env vars not set — see README.');
  }
  const target = CAMERA_API + camPath;
  const headers = {
    Authorization: CAMERA_AUTH,
    'Content-Type': req.headers['content-type'] || 'application/json',
  };
  let body = null;
  if (req.method === 'PUT' || req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = Buffer.concat(chunks);
      // CRITICAL: the camera REST API hangs forever on chunked-encoded PUT/POST bodies
      // (Node defaults to Transfer-Encoding: chunked when no Content-Length is given).
      // Always declare the length so Node sends the body as Content-Length.
      headers['Content-Length'] = String(body.length);
      const preq = https.request(target, { method: req.method, headers, rejectUnauthorized: false }, (pres) => {
        const out = [];
        pres.on('data', (c) => out.push(c));
        pres.on('end', () => {
          const buf = Buffer.concat(out);
          res.writeHead(pres.statusCode || 500, { 'Content-Type': pres.headers['content-type'] || 'application/json' });
          res.end(buf);
        });
      });
      preq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('camera proxy error: ' + e.message); });
      if (body && body.length) preq.write(body);
      preq.end();
    });
    return;
  }
  const preq = https.request(target, { method: req.method, headers, rejectUnauthorized: false }, (pres) => {
    const out = [];
    pres.on('data', (c) => out.push(c));
    pres.on('end', () => {
      const buf = Buffer.concat(out);
      res.writeHead(pres.statusCode || 500, { 'Content-Type': pres.headers['content-type'] || 'application/json' });
      res.end(buf);
    });
  });
  preq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('camera proxy error: ' + e.message); });
  preq.end();
}

// ---------- helpers ----------
function localIPv4() {
  const ifaces = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) all.push(iface.address);
    }
  }
  // prefer a private-range LAN address, else any non-internal IPv4
  const priv = all.find((a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return priv || all[0] || '127.0.0.1';
}
const MY_IP = localIPv4();
const WHEP_URL = 'http://' + MY_IP + ':' + MEDIAMTX_HTTP_PORT + '/live/whep';

// ---------- SRT -> fMP4/pipe -> WebSocket relay ----------
const STREAM = {
  port: Number(process.env.SRT_PORT || 9000),
  proc: null,
  startedAt: null,
  log: [],
  init: null,    // ftyp+moov bytes, sent to every new client first
  partial: null, // stdout bytes accumulated while still searching for init
  wantRunning: false,
  restartTimer: null,
  restarts: 0,
  watchdogTimer: null,   // cold-start WHIP liveness watchdog
  lastStdoutAt: 0,       // last time ffmpeg produced any MSE/stdout data
  overflowStreak: 0,     // consecutive poll windows with SRT-receiver overflow spam
  spawnedAt: 0,          // ms timestamp of last ffmpeg spawn (grace window for srt-bind check)
  srtBound: null,        // last SRT-listener probe result (true/false), updated by the watchdog
};

const wss = new WebSocketServer({ noServer: true });

// offset of the first 'moof' box (= end of init segment), or -1 if not present yet
function findInitEnd(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'moof') return off;
    let boxSize = size;
    if (size === 1) {
      if (off + 16 > buf.length) return -1;
      boxSize = Number(buf.readBigUInt64BE(off + 8));
    }
    if (boxSize < 8 || !Number.isFinite(boxSize)) return -1;
    off += boxSize;
  }
  return -1;
}

function sendInit(ws) {
  if (!STREAM.init || ws.sentInit || ws.readyState !== 1) return;
  try { ws.send(STREAM.init); ws.sentInit = true; } catch (_) {}
}

function broadcast(chunk) {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || !ws.sentInit) continue;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { try { ws.close(1008, 'slow client'); } catch (_) {} continue; }
    try { ws.send(chunk); } catch (_) {}
  }
}

wss.on('connection', (ws) => {
  ws.sentInit = false;
  ws.on('error', () => {}); // never let a client socket error crash the server
  sendInit(ws);
});
wss.on('error', (e) => console.error('[wss error]', e.message));

function closeAllClients() {
  for (const ws of wss.clients) { try { ws.close(1011, 'stream ended'); } catch (_) {} }
}

// ---------- mediaMTX supervisor (WebRTC WHIP-in / WHEP-out) ----------
const MTX = {
  proc: null,
  log: [],
  restarts: 0,
  restartTimer: null,
};
function mtxPush(line) {
  const s = String(line).trim();
  if (!s) return;
  MTX.log.push(s);
  if (MTX.log.length > 200) MTX.log.shift();
}
function spawnMediaMtx() {
  MTX.proc = spawn(MEDIAMTX, [], { cwd: path.dirname(MEDIAMTX), windowsHide: true });
  MTX.proc.stdout.on('data', mtxPush);
  MTX.proc.stderr.on('data', mtxPush);
  MTX.proc.on('exit', (code) => {
    mtxPush('[mediamtx exited code=' + code + ']');
    MTX.proc = null;
    MTX.restarts++;
    MTX.restartTimer = setTimeout(() => { MTX.restartTimer = null; spawnMediaMtx(); }, 1000);
  });
  MTX.proc.on('error', (e) => mtxPush('[mediamtx error] ' + e.message));
}
function startMediaMtx() { if (MTX.proc && MTX.proc.exitCode === null) return; spawnMediaMtx(); }
function stopMediaMtx() {
  if (MTX.restartTimer) { clearTimeout(MTX.restartTimer); MTX.restartTimer = null; }
  if (!MTX.proc) return;
  const p = MTX.proc; MTX.proc = null;
  try { p.kill('SIGTERM'); } catch (_) {}
}

function streamStatus() {
  return {
    running: !!STREAM.proc && STREAM.proc.exitCode === null,
    pid: STREAM.proc ? STREAM.proc.pid : null,
    port: STREAM.port,
    url: 'srt://' + MY_IP + ':' + STREAM.port + '?mode=listener',
    wsUrl: 'ws://' + MY_IP + ':' + (process.env.PORT || 9090) + '/ws/live',
    startedAt: STREAM.startedAt,
    clients: wss.clients.size,
    restarts: STREAM.restarts,
    srtBound: STREAM.srtBound,
    lastLog: STREAM.log.slice(-60),
    mediaMtx: {
      running: !!MTX.proc && MTX.proc.exitCode === null,
      restarts: MTX.restarts,
      whepUrl: WHEP_URL,
      lastLog: MTX.log.slice(-30),
    },
  };
}

function spawnFfmpeg() {
  STREAM.init = null;
  STREAM.partial = null;
  STREAM.lastStdoutAt = Date.now();
  STREAM.overflowStreak = 0;
  STREAM.spawnedAt = Date.now();
  STREAM.srtBound = null;
  const input = 'srt://0.0.0.0:' + STREAM.port + '?mode=listener&latency=120000';
  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', input,
    // silent audio input for the WHIP leg — FFmpeg 8's WHIP muxer requires
    // BOTH a video and an audio track, and the audio MUST be stereo (the
    // muxer rejects mono: "Unsupported audio channels 1 by RTC, choose stereo").
    // It's pure silence; the browser only wires the video track.
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    // output 0 -> WebRTC/WHIP to local mediaMTX (low-latency browser path).
    // H.264 passthrough (copy), NOT re-encode: FFmpeg 8's WHIP muxer does not
    // emit in-band SPS/PPS when it is the encoder, so browsers get 0 decodable
    // frames (PLI storm). Copying the camera TS keeps SPS/PPS in-band at every
    // keyframe -> Chrome decodes immediately. Bonus: removes transcode delay
    // from the WebRTC path. Camera must stream H.264 without B-frames (it does).
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000',
    '-fflags', 'nobuffer',
    '-f', 'whip', WHIP_URL,
    // output 1 -> fMP4 to stdout (existing WS/MSE fallback path, video-only)
    '-map', '0:v:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-crf', '21',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
    '-flush_packets', '1',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    '-frag_duration', '250000',
    '-f', 'mp4', 'pipe:1',
  ];
  STREAM.proc = spawn(FFMPEG, args, { windowsHide: true });
  const proc = STREAM.proc;
  STREAM.startedAt = new Date().toISOString();
  const push = (b) => {
    const line = String(b).trim();
    if (!line) return;
    STREAM.log.push(line);
    if (STREAM.log.length > 400) STREAM.log.shift();
  };
  proc.stdout.on('data', (chunk) => {
    STREAM.lastStdoutAt = Date.now();   // pipeline is alive / producing
    STREAM.overflowStreak = 0;          // flowing stdout = healthy; clear any stale overflow
    if (!STREAM.init) {
      STREAM.partial = STREAM.partial ? Buffer.concat([STREAM.partial, chunk]) : Buffer.from(chunk);
      const at = findInitEnd(STREAM.partial);
      if (at > 0) {
        STREAM.init = STREAM.partial.subarray(0, at);
        const rest = STREAM.partial.subarray(at);
        STREAM.partial = null;
        for (const ws of wss.clients) sendInit(ws);
        if (rest.length) broadcast(rest);
      }
      return;
    }
    broadcast(chunk);
  });
  proc.stderr.on('data', (b) => {
    const line = String(b);
    if (line.indexOf('No room to store incoming packet') !== -1) {
      // SRT receiver overflowing means ffmpeg's downstream WHIP publish is
      // wedged (cold-start race vs. a just-booted mediaMTX). The watchdog
      // will force a kill->respawn. Count it separately, not in the log.
      STREAM.overflowStreak = Math.min(STREAM.overflowStreak + 1, 1e9);
    }
    push(b);
  });
  proc.on('exit', (code) => {
    // If a newer ffmpeg already replaced this one (watchdog kill->respawn), the
    // late 'exit' from the killed process must not clobber the new proc or
    // trigger a duplicate respawn.
    if (STREAM.proc !== proc) return;
    push('[ffmpeg exited code=' + code + ']');
    STREAM.proc = null;
    STREAM.init = null;
    STREAM.partial = null;
    stopWatchdog();
    closeAllClients();
    // supervisor: keep the listener alive so the camera can reconnect on its own
    if (STREAM.wantRunning) {
      STREAM.restarts++;
      push('[supervisor] restarting listener in 800ms (restart #' + STREAM.restarts + ')');
      STREAM.restartTimer = setTimeout(() => {
        STREAM.restartTimer = null;
        if (STREAM.wantRunning) spawnFfmpeg();
      }, 800);
    }
  });
  proc.on('error', (e) => push('[ffmpeg error] ' + e.message));
  startWatchdog();
}

// Cold-start WHIP liveness watchdog. ffmpeg's WHIP publish can hang SILENTLY
// against a just-booted mediaMTX: it doesn't error and doesn't exit, so the
// exit-only supervisor never fires. The WHIP leg freezes, the SRT receiver
// stops draining and overflows ("No room to store incoming packet" spam), and
// no init segment is ever produced -> black video. The reliable wedge signal is
// SRT-overflow spam with NO stdout progress. We force-kill ffmpeg so the exit
// supervisor respawns it fresh (kill->respawn is exactly what clears it).

// Surprising third wedge: ffmpeg stays alive and keeps its WHIP connection to
// mediaMTX, but its SRT listener socket silently vanishes — nothing is bound on
// STREAM.port any more. No process exit, no overflow spam (no packets even reach
// it), so the two signals above never fire. The camera sits at "Connecting"
// forever and no frames flow. This check parses netstat for a UDP listen on the
// SRT port owned by our ffmpeg PID; returns true (bound) when the bind is present
// or the check itself can't run (fail-open: an uncertain probe must never kill a
// healthy stream).
function srtListenerBound() {
  const p = STREAM.proc;
  if (!p || p.exitCode !== null || !p.pid) return true;
  // Skip the first seconds after spawn — ffmpeg hasn't bound the socket yet and
  // a freshly respawned process must not be killed by an early poll.
  if (Date.now() - STREAM.spawnedAt < 10000) return true;
  try {
    // netstat -ano -p udp columns: Proto | Local Address | Foreign Address | PID
    // (no State column for UDP). A SRT listener shows a *:* foreign address with
    // the local address ending in :PORT. Match the LOCAL column only — matching
    // anywhere would also hit connected sockets whose remote peer happens to use
    // the same port number.
    const out = execSync('netstat -ano -p udp', { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    const wantPort = ':' + STREAM.port;
    const pid = String(p.pid);
    return out.split(/\r?\n/).some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[0] === 'UDP' && cols[1] && cols[1].endsWith(wantPort) && cols[cols.length - 1] === pid;
    });
  } catch (_) {
    return true; // netstat unavailable/failed -> don't kill on a false alarm
  }
}

function startWatchdog() {
  stopWatchdog();
  STREAM.watchdogTimer = setInterval(() => {
    if (!STREAM.wantRunning || !STREAM.proc) return;      // state machine idle; nothing to do
    if (STREAM.proc.exitCode !== null) return;            // already exited; supervisor handles it
    STREAM.srtBound = srtListenerBound();
    const wedged = !STREAM.srtBound;
    const overflowing =
      STREAM.overflowStreak > 0 &&
      (Date.now() - STREAM.lastStdoutAt > 15000);
    const reason = wedged
      ? ('SRT listener socket not bound (port ' + STREAM.port + ') — forcing kill -> respawn')
      : overflowing
        ? ('SRT overflow, no stdout for ' + Math.round((Date.now() - STREAM.lastStdoutAt) / 1000) + 's — forcing kill -> respawn')
        : null;
    if (!reason) return;
    push('[watchdog] ffmpeg wedged: ' + reason);
    STREAM.overflowStreak = 0;
    stopWatchdog();
    const p = STREAM.proc;
    STREAM.proc = null;                 // clear so a late real 'exit' doesn't double-restart
    STREAM.init = null;
    try { p.kill('SIGKILL'); } catch (_) {}
    closeAllClients();                  // behave like a crash: page rebuilds the player now
    if (STREAM.wantRunning) spawnFfmpeg();   // immediate fresh start (no 800ms wait needed)
  }, 5000);
}

function stopWatchdog() {
  if (STREAM.watchdogTimer) { clearInterval(STREAM.watchdogTimer); STREAM.watchdogTimer = null; }
}

function startStream() {
  if (STREAM.proc && STREAM.proc.exitCode === null) return { ok: false, error: 'already running' };
  STREAM.log = [];
  STREAM.restarts = 0;
  STREAM.wantRunning = true;
  if (STREAM.restartTimer) { clearTimeout(STREAM.restartTimer); STREAM.restartTimer = null; }
  spawnFfmpeg();
  return { ok: true, status: streamStatus() };
}

function stopStream() {
  STREAM.wantRunning = false;
  if (STREAM.restartTimer) { clearTimeout(STREAM.restartTimer); STREAM.restartTimer = null; }
  stopWatchdog();
  if (!STREAM.proc) return { ok: false, error: 'not running' };
  const p = STREAM.proc;
  STREAM.proc = null;
  try { p.kill('SIGKILL'); } catch (_) {}
  STREAM.startedAt = null;
  return { ok: true };
}

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.stack || e);
  try { STREAM.log.push('[uncaughtException] ' + (e && e.message)); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e);
});

// ---------- HTTP server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // --- API ---
  if (urlPath === '/api/config') {
    return sendJSON(res, {
      pcIP: MY_IP,
      srtPort: STREAM.port,
      srtUrl: 'srt://' + MY_IP + ':' + STREAM.port + '?mode=listener',
      wsPath: '/ws/live',
      whepUrl: WHEP_URL,
      cameraHost: CAMERA_HOST,
    });
  }
  if (urlPath === '/api/stream/status') return sendJSON(res, streamStatus());
  if (urlPath === '/api/stream/start') {
    const r = startStream();
    return sendJSON(res, r.status || { error: r.error }, r.ok ? 200 : 409);
  }
  if (urlPath === '/api/stream/stop') {
    const r = stopStream();
    return sendJSON(res, r, r.ok ? 200 : 409);
  }
  if (urlPath.startsWith('/cam/')) {
    return proxyCamera(req, res, urlPath.replace(/^\/cam/, ''));
  }

  // --- static files ---
  const filePath = urlPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// WebSocket upgrade: /ws/live only
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // dead client sockets must not crash the server
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/ws/live') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = Number(process.env.PORT || 9090);
server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  PYXIS 6K Live (WebRTC primary / WS-MSE fallback)');
  console.log('------------------------------------------');
  console.log('  Page        : http://localhost:' + PORT);
  console.log('  WebRTC (WHEP): ' + WHEP_URL);
  console.log('  WS fallback  : ws://' + MY_IP + ':' + PORT + '/ws/live');
  console.log('  SRT ingest  : srt://' + MY_IP + ':' + STREAM.port + '?mode=listener');
  console.log('------------------------------------------');
  console.log('  REST APIs:');
  console.log('    GET  /api/stream/status');
  console.log('    POST /api/stream/start   (open SRT listener -> WHIP + WS relay)');
  console.log('    POST /api/stream/stop');
  console.log('==========================================');
  startMediaMtx();
});

process.on('exit', () => stopMediaMtx());
process.on('SIGINT', () => { stopMediaMtx(); process.exit(0); });
process.on('SIGTERM', () => { stopMediaMtx(); process.exit(0); });

module.exports = { startStream, stopStream, streamStatus, STREAM, FFMPEG, MEDIAMTX, WHEP_URL };

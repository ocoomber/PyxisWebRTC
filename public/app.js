/* PYXIS 6K Live — WebRTC (WHEP) primary with WS/MSE fallback, video-only, low latency */

const $ = (id) => document.getElementById(id);
const setStat = (id, val, cls) => {
  const el = $(id);
  el.textContent = val != null ? val : '—';
  el.className = (cls || 'muted');
};

let cfg = null;
let playerStarted = false;
let pollTimer = null;

let transport = null;        // 'webrtc' | 'mse' | null
let pc = null;               // active RTCPeerConnection (webrtc)
let webrtcTimer = null;      // webrtc connect timeout
let webrtcSwitched = false;  // already fell back to MSE this player session

// stream-session state: the player is (re)built on every "stream came up"
// transition so Stop→Start / camera blips / mediaMTX restarts re-engage the
// low-latency WebRTC path instead of leaving a stale player behind.
let lastUp = false;          // effective up-state of the last refreshStatus poll
let lastCameraUp = false;    // camera was Streaming/Connecting last poll
let lastFormat = null;       // last effectiveVideoFormat observed from the camera
let lastInitAt = 0;          // last time the player was (re)built
let stallCount = 0;          // consecutive WebRTC frames-identical counts
let lastWebRtcFrames = 0;    // frames count at last WebRTC health check

let ws = null;
let mediaSource = null;
let sourceBuffer = null;
let sbReady = false;
let codec = null;
let queue = [];
let reconnectTimer = null;

// camera API via our server proxy (/cam -> https://camera with basic auth)
async function cam(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch('/cam' + path, opts);
  const text = await resp.text();
  try { return { status: resp.status, data: text ? JSON.parse(text) : null }; }
  catch (_) { return { status: resp.status, data: text }; }
}

async function loadConfig() {
  try {
    cfg = await (await fetch('/api/config')).json();
    $('streamTarget').textContent = 'srt://' + cfg.pcIP + ':' + cfg.srtPort + '?mode=caller';
  } catch (_) {}
}

function setHint(txt, cls) {
  const el = $('streamHint');
  if (!el) return;
  el.textContent = txt;
  el.className = 'hint small ' + (cls || '');
}

function showPlaceholder(txt) {
  const el = $('videoPlaceholder');
  if (txt == null) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = txt;
}

function setTransportLabel(label) {
  const el = $('playerStats');
  if (el) el.setAttribute('data-transport', label == null ? '' : label);
}

/* ------------------------------------------------------------------ */
/* WebRTC / WHEP path (primary)                                        */
/* ------------------------------------------------------------------ */

function startWebRTC() {
  transport = 'webrtc';
  setTransportLabel('connecting');
  showPlaceholder('connecting WebRTC…');

  if (!cfg || !cfg.whepUrl) { console.warn('no whepUrl; falling back to MSE'); return fallbackToMSE(); }

  try { pc = new RTCPeerConnection({ iceServers: [] }); } catch (e) {
    console.warn('RTCPeerConnection unavailable (' + e.message + '); fallback to MSE');
    pc = null;
    return fallbackToMSE();
  }

  try { pc.addTransceiver('video', { direction: 'recvonly' }); } catch (_) {}

  const stream = new MediaStream();
  pc.ontrack = (ev) => {
    if (ev.track.kind !== 'video') return; // only wire the video track
    stream.addTrack(ev.track);
    const video = $('video');
    video.srcObject = stream;
    video.muted = true;
    video.play().catch(() => {});
    showPlaceholder(null); // media is on its way; drop the overlay
  };

  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === 'failed') {
      console.warn('WebRTC connection failed; fallback to MSE');
      teardownWebRTC();
      fallbackToMSE();
    }
  };

  // global timeout: if we haven't gotten media by now, cut over to MSE
  webrtcTimer = setTimeout(() => {
    const v = $('video');
    const haveMedia = v && v.srcObject && v.srcObject.getVideoTracks().length > 0;
    if (!haveMedia) {
      console.warn('WebRTC timed out without media; fallback to MSE');
      teardownWebRTC();
      fallbackToMSE();
    }
  }, 8000);

  // WHEP signalling (mode 1): the CLIENT builds the offer and POSTs it to the
  // WHEP URL; the response body is the server's answer SDP. mediaMTX rejects
  // mode-2 (GET server offer) with 405, so do NOT send a GET offer request.
  (async () => {
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // non-trickle: wait for ICE gathering to finish so the offer has all
      // candidates, then hand the complete offer to mediaMTX
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const onEnd = () => {
          if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', onEnd); resolve(); }
        };
        pc.addEventListener('icegatheringstatechange', onEnd);
        setTimeout(resolve, 3000); // never hang the handshake on gathering
      });
      if (pc.signalingState !== 'stable') await pc.setLocalDescription(pc.localDescription); // re-apply if needed
      if (!pc) return; // torn down while gathering
      const res = await fetch(cfg.whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', 'Accept': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
      if (!res.ok) throw new Error('WHEP POST ' + res.status + ' ' + (await res.text().catch(() => '')));
      const answerSdp = await res.text();
      if (!pc) return; // torn down while the answer was in flight
      if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      }
    } catch (err) {
      console.warn('WHEP handshake failed: ' + err.message + '; fallback to MSE', err);
      teardownWebRTC();
      fallbackToMSE();
    }
  })();
}

function teardownWebRTC() {
  if (webrtcTimer) { clearTimeout(webrtcTimer); webrtcTimer = null; }
  if (pc) {
    try { pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); } catch (_) {}
    pc = null;
  }
  const video = $('video');
  if (video && video.srcObject) { try { video.srcObject = null; } catch (_) {} }
  if (transport === 'webrtc') transport = null;
}

/* ------------------------------------------------------------------ */
/* WS / MSE path (fallback)                                            */
/* ------------------------------------------------------------------ */

// Build the exact MSE codec string from the stream's avcC box (PPCCLL).
function parseCodec(initBuf) {
  const b = new Uint8Array(initBuf);
  const hex = (x) => x.toString(16).padStart(2, '0');
  for (let i = 0; i + 8 < b.length; i++) {
    if (b[i] === 0x61 && b[i + 1] === 0x76 && b[i + 2] === 0x63 && b[i + 3] === 0x43) { // 'avcC'
      const pp = b[i + 5], cc = b[i + 6], ll = b[i + 7];
      return 'video/mp4; codecs="avc1.' + hex(pp) + hex(cc) + hex(ll) + '"';
    }
  }
  return 'video/mp4; codecs="avc1.42c028"'; // fallback (Constrained Baseline L4.0)
}

function drainQueue() {
  if (!sbReady || !sourceBuffer || sourceBuffer.updating || !queue.length) return;
  if (!mediaSource || mediaSource.readyState !== 'open') { queue = []; return; }
  try {
    sourceBuffer.appendBuffer(queue.shift());
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      trimBuffer(true);
      drainQueue();
    } else {
      queue = [];
    }
  }
}

function trimBuffer(aggressive) {
  const video = $('video');
  if (!sourceBuffer || sourceBuffer.updating || !video.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  const start = video.buffered.start(0);
  const keep = aggressive ? 2 : 8;
  if (end - start > keep) {
    try { sourceBuffer.remove(start, end - keep); } catch (_) {}
  }
}

// live-edge chase: hold ~0.3s cushion behind the received edge so delivery
// jitter gets absorbed instead of stalling playback (stalls look like frame drops)
setInterval(() => {
  if (transport !== 'mse') return;
  const video = $('video');
  if (!sourceBuffer || !video.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  const behind = end - video.currentTime;
  if (behind > 1.0) {
    video.currentTime = end - 0.35;
    video.playbackRate = 1.0;
  } else if (behind > 0.55) {
    video.playbackRate = 1.05;
  } else {
    video.playbackRate = 1.0;
  }
}, 250);

// evict old buffer from memory every 2s
setInterval(() => { if (transport === 'mse') trimBuffer(false); }, 2000);

// player health line: rendered fps, compositor drops, distance behind live edge
let lastQ = null;
let lastQT = 0;
setInterval(() => {
  const video = $('video');
  const el = $('playerStats');
  if (!el || !video || !video.getVideoPlaybackQuality) return;
  const q = video.getVideoPlaybackQuality();
  const now = performance.now();
  if (lastQ && now - lastQT > 1000) {
    const dt = (now - lastQT) / 1000;
    const fps = (q.totalVideoFrames - lastQ.totalVideoFrames) / dt;
    const drops = q.droppedVideoFrames - lastQ.droppedVideoFrames;
    if (fps > 0.5) {
      let txt;
      if (transport === 'webrtc') {
        txt = 'WebRTC · ' + fps.toFixed(1) + ' fps · ' + drops + ' dropped';
      } else if (transport === 'mse') {
        const behind = video.buffered.length
          ? video.buffered.end(video.buffered.length - 1) - video.currentTime
          : null;
        txt = 'MSE fallback · ' + fps.toFixed(1) + ' fps · ' + drops + ' dropped' + (behind != null ? ' · ' + behind.toFixed(2) + 's behind' : '');
      } else {
        txt = '';
      }
      if (txt) setStat('playerStats', txt, (drops > 5 || fps < 20) ? 'status err' : 'status ok');
    }
  }
  lastQ = q; lastQT = now;

  // transport recovery: re-initialise (WebRTC-first) if the connection died or
  // frames stalled ~8s (mediaMTX/ffmpeg crash), or if MSE got no data while the
  // camera claims Streaming — self-heals without a page reload.
  if (transport === 'webrtc') {
    const dead = pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed');
    if (lastWebRtcFrames === q.totalVideoFrames) stallCount++; else { stallCount = 0; lastWebRtcFrames = q.totalVideoFrames; }
    if ((stallCount >= 4 || dead) && now - lastInitAt > 10000) {
      console.warn('WebRTC dead/stalled; rebuilding player');
      resetPlayerState();
      bootPlayer();
      return;
    }
  } else if (transport === 'mse' && codec === null && lastCameraUp && now - lastInitAt > 10000) {
    console.warn('no video data while camera is up; rebuilding player');
    resetPlayerState();
    bootPlayer();
    return;
  }
}, 2000);

function destroyMsePlayer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch (_) {} ws = null; }
  queue = [];
  sbReady = false;
  codec = null;
  if (mediaSource) {
    try {
      if (sourceBuffer && mediaSource.readyState === 'open') mediaSource.removeSourceBuffer(sourceBuffer);
    } catch (_) {}
    try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (_) {}
    mediaSource = null;
  }
  sourceBuffer = null;
}

function scheduleReconnect() {
  if (transport !== 'mse' || reconnectTimer) return;
  showPlaceholder('reconnecting…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    destroyMsePlayer();
    initMsePlayer();
  }, 1000);
}

function startMediaSource() {
  const video = $('video');
  if (!MediaSource.isTypeSupported(codec)) {
    showPlaceholder('codec unsupported: ' + codec);
    return;
  }
  video.removeAttribute('src');
  mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(codec);
    } catch (e) {
      showPlaceholder('decoder error: ' + e.message);
      return;
    }
    sourceBuffer.addEventListener('updateend', drainQueue);
    sourceBuffer.addEventListener('error', () => {});
    sbReady = true;
    showPlaceholder(null);
    drainQueue(); // flush anything buffered while MediaSource was opening
  });
}

function connectWs() {
  ws = new WebSocket('ws://' + location.host + '/ws/live');
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (transport !== 'mse') return;
    queue.push(ev.data);
    if (codec === null) {           // first message is the init segment (ftyp+moov)
      codec = parseCodec(ev.data);
      startMediaSource();
    }
    drainQueue();
  };
  ws.onclose = () => { if (transport === 'mse') { ws = null; scheduleReconnect(); } };
  ws.onerror = () => { try { if (ws) ws.close(); } catch (_) {} };
}

function initMsePlayer() {
  if (transport === 'webrtc') return; // never run MSE while WebRTC is live
  transport = 'mse';
  setTransportLabel('mse');
  destroyMsePlayer();
  if (!('MediaSource' in window)) {
    showPlaceholder('this browser cannot play MSE H.264');
    return;
  }
  showPlaceholder('connecting WS (MSE)…');
  connectWs();
  // if nothing arrives on the WS soon, show a hint but keep trying
  setTimeout(() => {
    if (transport === 'mse' && codec === null) setHint('waiting for stream data…');
  }, 4000);
}

/* when WebRTC cannot start/connect, switch to the MSE player */
function fallbackToMSE() {
  if (webrtcSwitched) return; // prevent loops
  webrtcSwitched = true;
  teardownWebRTC();
  initMsePlayer();
}

/* tear down everything and clear the one-shot guards so the next boot tries
   WebRTC afresh (used on stream up-transitions and transport recovery) */
function resetPlayerState() {
  teardownWebRTC();
  destroyMsePlayer();
  transport = null;
  playerStarted = false;
  webrtcSwitched = false;
  stallCount = 0;
  lastWebRtcFrames = 0;
}

function bootPlayer() {
  lastInitAt = performance.now();
  playerStarted = true;
  initPlayer();
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

function initPlayer() {
  if (!playerStarted) return;
  // prefer WebRTC if the browser supports it; otherwise straight to MSE
  if ('RTCPeerConnection' in window && !webrtcSwitched) {
    startWebRTC();
  } else {
    initMsePlayer();
  }
}

const camUp = (st) => st === 'Streaming' || st === 'Connecting';

async function refreshStatus() {
  let s = null;
  try { s = await (await fetch('/api/stream/status')).json(); } catch (_) {}
  let c = null;
  try { c = await cam('GET', '/livestreams/0'); } catch (_) {}
  const camSt = (c && c.data && c.data.status) ? c.data.status : null;
  const fmt = (c && c.data && c.data.effectiveVideoFormat) ? c.data.effectiveVideoFormat : null;
  if (s) setStat('listenerStatus', s.running ? 'SRT listener on :' + s.port + ' · ' + s.clients + ' viewer(s)' : 'listener stopped');
  lastCameraUp = camUp(camSt);
  if (camSt) {
    // show what the camera actually agreed to, e.g. "Streaming · 1080p24 · 4.6 Mbps"
    const fmtTxt = fmt ? ' · ' + fmt.replace(/^\d+x/, '') : '';
    const bpsTxt = c.data.bitrate ? ' · ' + Math.round(c.data.bitrate / 100000) / 10 + ' Mbps' : '';
    if (camUp(camSt) && s && !s.running) {
      // listener is down, so the camera says "Streaming" but delivers 0 data —
      // that's its session still being alive; it cannot be remote-stopped.
      setStat('camStatus', camSt + fmtTxt + (c.data.bitrate < 100000 ? ' · 0 data (feed stopped — camera can\'t be remote-stopped)' : ''));
    } else {
      setStat('camStatus', camSt + fmtTxt + bpsTxt);
    }
  }
  const up = !!(s && s.running && lastCameraUp);
  const fmtChanged = fmt != null && lastFormat != null && fmt !== lastFormat;
  if (fmt != null && fmt !== lastFormat) lastFormat = fmt;
  if (up !== lastUp) {
    lastUp = up;
    if (up) {
      // fresh transport session: rebuild the player and give WebRTC first shot
      resetPlayerState();
      bootPlayer();
    } else {
      resetPlayerState();
      setTransportLabel('stopped');
      setStat('playerStats', '', 'muted');
      showPlaceholder(s && s.running ? 'camera not streaming — waiting for the feed…' : 'listener starting…');
    }
  } else if (up && fmtChanged) {
    // fps/resolution changed on the camera mid-stream (its encoder restarted) —
    // rebuild the player so the browser re-syncs instead of needing a refresh.
    console.warn('camera format changed to ' + fmt + '; rebuilding player');
    resetPlayerState();
    bootPlayer();
  }
}

/* ---------------- stop-server control ---------------- */

function wireStopServer() {
  const btn = $('stopServerBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled || btn.classList.contains('disarmed')) return;
    const ok = confirm(
      'Stop the live-view server on this PC?\n\n' +
      'This stops the app (ffmpeg + mediaMTX) running on this computer.\n' +
      'Your camera is NOT affected — it keeps streaming on its own.\n\n' +
      'Restart it later by running "npm start" again.'
    );
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'stopping…';
    btn.classList.add('disarmed');
    try { await fetch('/api/shutdown', { method: 'POST' }); } catch (_) {}
    // the server is going away; stop polling and tell the user
    try { clearInterval(pollTimer); } catch (_) {}
    setStat('listenerStatus', 'server stopped — safe to close this tab', 'muted');
    setHint('This PC no longer listens for the camera. Restart with "npm start".');
    showPlaceholder('Server stopped');
  });
}

(async () => {
  await loadConfig();
  // start the PC listener if it isn't running; the camera reconnects on its own
  try {
    const s = await (await fetch('/api/stream/status')).json();
    if (!s.running) {
      await fetch('/api/stream/start', { method: 'POST' });
      setHint('PC listener started — waiting for the camera feed…');
    }
  } catch (_) {}
  refreshStatus();
  pollTimer = setInterval(refreshStatus, 3000);
  wireStopServer();
})();

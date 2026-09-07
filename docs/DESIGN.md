# Design & how it works

This document explains the system end-to-end. It's a deep dive for readers who want to
understand *why* it behaves the way it does — every architectural decision here was earned
the hard way against a real PYXIS 6K on a real set network.

## Goal

A near-zero-delay, browser-based live view of a Blackmagic PYXIS over wired Ethernet, good
enough for pulling focus. Target glass-to-glass: under half a second. No hardware
decoders, no cloud, no proprietary plugins — just ffmpeg, one Go binary, and the browser.

## Pipeline

```
PYXIS 6K
  │  camera's built-in livestream engine, custom platform XML (streaming.xml)
  │  SRT caller → srt://<PC>:9000?mode=caller
  ▼
ffmpeg (PC, the SRT listener :9000)
  ├── input 0: SRT (H.264 MPEG-TS, latency=120000)
  ├── input 1: anullsrc=stereo silence (see "WHIP quirks")
  ├── output 0: -c:v copy -c:a libopus -f whip http://127.0.0.1:8889/live/whip
  │             → mediaMTX (WebRTC server) → WHEP → browser RTCPeerConnection   PRIMARY
  └── output 1: -an -c:v libx264 ... -f mp4 pipe:1 → WS relay → MSE SourceBuffer FALLBACK
```

Two outputs share a single SRT decode. Output 0 is pure passthrough (no transcode), which is
both the latency win and the decode fix (below). Output 1 re-encodes for the MSE fallback.

## Protocol flow

### WebRTC path (primary)

1. Browser fetches `/api/config` → `whepUrl` = `http://<PC_IP>:8889/live/whep`.
2. Browser creates `RTCPeerConnection`, adds a **recvonly video transceiver**.
3. Browser builds an offer, waits for ICE gathering to complete (non-trickle), and POSTs the
   full offer to the WHEP URL with `Content-Type: application/sdp`.
4. mediaMTX answers `201` with the answer SDP in the body. Browser
   `setRemoteDescription({ type: 'answer' })`.
5. ICE/DTLS/SRTP establish over UDP 8189; browser wires only the **video** track to the
   video element. The camera feed appears ~1s after opening the page.
6. On failure (handshake error, 8s media timeout, `connectionState === 'failed'`): tear down
   and start the MSE path. One-shot `playerStarted` guard prevents the player being
   recreated per poll (that was the old "flashing" bug).

### MSE path (fallback)

- ffmpeg writes fragmented MP4 to stdout. The server walks the boxes, splits the init segment
  (`ftyp` + `moov`) from the first `moof`, caches init, and relays live fragments over a
  WebSocket (`/ws/live`). New clients always get init first, then run fragments.
- The player parses the exact `avcC` codec string at runtime (`avc1.42c028` etc.) and chases
  the live edge: hard-seek if >1.0s behind (lands 0.35s back), `playbackRate 1.05` if
  >0.55s behind. This cushion absorbs delivery jitter without microstalling.

## Latency budget

| Path | Pipeline | Glass-to-glass |
|---|---|---|
| WebRTC | SRT buffering (~120–250ms, both peers) + copy/passthrough + ICE/RTP on LAN (~7ms jitter) + 1 decode frame | **~0.2–0.4s** |
| MSE | above + 250ms fragment cadence + ~0.35s chase cushion | ~0.4–0.8s |

Once on the WebRTC path there is no fragment cadence and no chase cushion left to tune. The
only remaining lever is **camera-side SRT latency**, which (for PYXIS) is an encoder/buffer
setting on the camera, not something we control from the URL.

## The WHIP gotchas (the hard-won stuff)

### 1. Re-encoding on the WHIP leg produces black video (PLI storm)

This was the biggest bug. With `-c:v libx264` feeding `-f whip`, the browser would connect
(negotiated H.264, packets flowing, `iceState: connected`) but **decode 0 frames** and spam
PLIs (~90+), `videoWidth: 0`. FFmpeg 8's WHIP muxer does **not** emit in-band SPS/PPS when
it is the *encoder*; the parameter sets it writes from encoder extradata are not carried in
the RTP stream, so Chrome never has what it needs to start a decode.

**Fix: `-c:v copy`.** When copying the camera's MPEG-TS H.264, SPS/PPS are already in-band at
every keyframe, so they ride through the WHIP muxer and Chrome decodes immediately
(`readyState: 4`, profile-level-id `42e01f`). This also removes transcode delay from the
low-latency path. It was verified against the real camera (0 dropped frames, PLI → ~0 after
attach) and against an A/B with mediaMTX's own built-in reader page, which failed identically
when fed the re-encoded stream — confirming the problem was upstream of the browser client.

Do not "optimize" this back to an encode. The camera must also stream H.264 **without
B-frames** (PYXIS live paths do) — B-frames would force mediaMTX into re-encode mode.

### 2. The WHIP muxer needs a stereo audio track

FFmpeg 8's WHIP muxer refuses to start with mono audio:

```
Unsupported audio channels 1 by RTC, choose stereo
```

so a second input provides **silent stereo**:
`-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000`, encoded `-c:a libopus`, and
mapped to the WHIP output only. The browser discards it and wires just the video track — no
audible change, but the publish succeeds.

**The camera's own audio is intentionally dropped.** PYXIS is configured to include audio in
its SRT stream (`audio-bitrate` in `streaming.xml`), but output 0 maps `1:a:0` (the silent
lavfi input), never `0:a:0`. This project is video-only by design. To carry real camera
audio, remove the lavfi input and change the WHIP output map to `-map 0:a:0` (the browser
page would need its `ontrack` to wire an audio track and drop `video.muted`).

### 3. mediaMTX WHEP is client-offer (mode 1)

Some WHEP implementations let the *client* hold the offer; mediaMTX does the opposite of what
you might guess: the **client POSTs its own offer** to the WHEP URL and gets the answer in
the response body. A mode-2 handshake (GET the offer from the server) returns `405 method
not allowed`. The whitelisted handshake is:

```
POST /live/whep          Content-Type: application/sdp, body = offer SDP
201                      Location: session-url,  body = answer SDP
PATCH /live/whep/:id     application/trickle-ice-sdpfrag (optional; non-trickle works)
```

## mediaMTX configuration

`mediamtx.yml` is deliberately **WebRTC-only**: rtsp/rtmp/hls/srt/api/moq all disabled.
HTTP/WHEP on `:8889`, WebRTC media UDP on `:8189`, one path `live`. `webrtcAdditionalHosts`
must list the PC's reachable LAN IP so browsers on the same LAN (and loopback) get a usable
ICE candidate.

mediaMTX is auto-spawned by the Node app on boot and auto-respawned 1s after any crash (a
second supervisor, parallel to the ffmpeg one). A mediaMTX crash kills the WHIP output →
ffmpeg exits → both supervisors respawn → the camera reconnects its SRT caller on its own.
Self-healing verified: killing mediaMTX recovered the whole chain in a few seconds.

## Supervisors

- **ffmpeg supervisor**: `POST /api/stream/start` sets `wantRunning` and spawns ffmpeg. If
  ffmpeg exits for any reason, it respawns after 800ms so the camera's SRT caller reconnects.
  `GET /api/stream/status` exposes `restarts` plus the tail of ffmpeg's log.
- **ffmpeg liveness watchdog**: exit-only supervision misses a *silent* crash where ffmpeg
  stays alive but stops working. It detects two modes: (1) a **cold-start WHIP hang** — the
  WHIP publish against a just-booted mediaMTX freezes without erroring/exiting (SRT receiver
  overflows with "No room to store incoming packet" spam, stdout stops, no init segment →
  black video); (2) a **vanished SRT listener** — ffmpeg keeps its WHIP connection but its
  SRT socket on `SRT_PORT` silently disappears, so the camera's caller gets nothing
  (`Connecting` forever, no frames, no overflow spam, no exit). The watchdog polls every 5s,
  force-killing ffmpeg (→ immediate supervisor respawn) when the SRT receiver keeps
  overflowing **and** stdout has produced nothing for >15s, **or** `netstat -ano -p udp`
  shows no UDP listen on the SRT port owned by our ffmpeg PID (after a 10s spawn grace
  period so a freshly-started process is never misjudged; a netstat failure skips the check
  rather than false-killing). A healthy idle-waiting ffmpeg (camera not streaming yet)
  produces no overflow and still holds its socket, so it is never touched.
- **mediaMTX supervisor**: same pattern, respawn after 1s, exposed as `status.mediaMtx`
  (running/restarts/whepUrl/lastLog).
- `POST /api/stream/stop` clears `wantRunning` and cancels the restart timers.
- **`POST /api/shutdown`** (the page's *Stop server* button, confirmed first): stops ffmpeg
  and mediaMTX, closes every WS client and both servers, then exits the Node process after
  ~300ms so the response flushes. `SIGINT`/`SIGTERM` (Ctrl+C) call the same routine, so a
  killed server never leaves orphan ffmpeg/mediaMTX behind squatting `:9000`/`:8889`. Only
  the PC side is stopped — the camera keeps streaming on its own.

## Camera REST bits

- HTTPS only, self-signed cert (`rejectUnauthorized: false` in the proxy), Basic auth.
- The app proxies `/cam/*` → `https://<CAMERA>/control/api/v1/*`, so
  `/cam/livestreams/0` works straight from the page origin.
- Custom platform uploaded via
  `PUT /control/api/v1/livestreams/customPlatforms/Pyxis_SRT.xml` (see `streaming.xml`).
- The camera is an **SRT caller**; the PC is the **listener**. If the listener isn't up, the
  stream can wedge (see TROUBLESHOOTING.md).

## Code map

```
server.js
  ├─ FFMPEG / MEDIAMTX / CAMERA_*  env-driven config
  ├─ proxyCamera()                 REST proxy → camera
  ├─ findInitEnd() / sendInit() / broadcast()   fMP4 box-splitting WS relay
  ├─ spawnMediaMtx() / startMediaMtx() / stopMediaMtx()   mediaMTX supervisor
  ├─ spawnFfmpeg()                 the two-output SRT→WHIP+fMP4 process
  ├─ streamStatus() / startStream() / stopStream()
  └─ HTTP server: /api/config, /api/stream/*, /cam/*, static public/, /ws/live

public/app.js
  ├─ loadConfig() → whepUrl
  ├─ startWebRTC()                 WHEP mode-1 handshake + recvonly video transceiver
  ├─ teardownWebRTC()              → fallbackToMSE()
  ├─ MSE path: parseCodec() from avcC, SourceBuffer append, live-edge chase
  └─ Player stats row (fps / dropped / transport label)
```

## Verification approach (no puppeteer needed)

Headless Chrome over CDP (`ws` lib): navigate to the page, wait, then dump
`video.readyState`, `getVideoPlaybackQuality()`, `pc.getStats()` inbound-rtp
(framesDecoded, pliCount, jitter), and the player status text. A healthy ride looks like:

```
readyState:4, framesDecoded>200, framesDropped:0, pliCount≈0,
statsText:"webrtc · 24.0 fps · 0 dropped"
```

`framesDecoded:0` + a large `pliCount` means someone put an encode back on the WHIP leg (see
the SPS/PPS section above). A real camera is not required for development — the whole
pipeline can be driven by a synthetic SRT caller:
`ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=24 -c:v libx264 -preset ultrafast -f mpegts srt://127.0.0.1:9000?mode=caller`.
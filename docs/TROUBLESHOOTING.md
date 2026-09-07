# Troubleshooting

Every failure mode we hit while building and running this against a real PYXIS 6K, with the
cure that actually worked. Read [DESIGN.md](DESIGN.md) first if you haven't.

## Black video: "connected" but nothing decodes (PLI storm)

**Symptoms:** the page opens, WebRTC connects (`iceState: connected`), bytes flow, but the
picture stays black and `videoWidth` stays 0. `pc.getStats()` shows `framesDecoded: 0` with
a large `pliCount` (tens to hundreds) — the decoder is begging for keyframes/SPS-PPS and
never getting usable ones.

**Cause:** someone put a re-encode on the WHIP leg. FFmpeg 8's WHIP muxer does **not** emit
in-band SPS/PPS when it is the encoder, so the browser can never start decoding.

**Cure:** the WHIP output must be `-c:v copy` (H.264 passthrough) so the camera's in-band
SPS/PPS at each keyframe survive into RTP. See `spawnFfmpeg()` in `server.js` and
[DESIGN.md](DESIGN.md). Do not "optimize" it back to `libx264`.

## Camera REST calls hang (chunked-encoded PUT/POST)

**Symptoms:** a browser request to `/cam/...` never gets a reply, even though the PC-side page
itself loads fine (GET `/cam/livestreams/0` works).

**Cause:** the camera's REST API **hangs forever on chunked-encoded PUT/POST bodies**. Node's
`https.request` switches to `Transfer-Encoding: chunked` when a body is written without an
explicit `Content-Length` — and unlike curl (which always sends `Content-Length`), the PYXIS
camera never answers. The proxy in `server.js` now pins `Content-Length` to the body length
before forwarding. If you write your own camera client, always set `Content-Length`.

**Diagnosis:** hit the camera directly with curl (instant 403/204) vs `node` (hang) — the
difference is the framing.

## "Stream is active to a different destination" (the wedge)

**Symptoms:** `PUT .../livestreams/0/start` (or the camera UI) returns
`403 Stream control cannot be performed: stream is active to a different destination`, even
though the session looks dead (`status` may read `Streaming` or `Interrupted`).

**Cause:** the camera-side livestream session is still bound to an old destination and won't
let you start/stop until it tears down cleanly. It happens when the SRT listener disappears
mid-session, or the platform XML is changed while streaming.

**Cures, in order (no power cycle needed):**
1. **Let it reach `Idle`.** Stop the SRT listener (or let ffmpeg die) and wait — the camera
   drops back to `Idle` on its own; `start` then returns `204`. This is the verified cure.
2. **Upload `streaming.xml` again while it's wedged** — the camera reloads config, the
   encoder resets, the SRT session tears down, back to `Idle`. A legitimate "un-wedge hammer".
3. Killing ffmpeg/mediaMTX (which kills the camera's session) also clears it, then restart
   the stack and start normally.

If the camera stays in `Interrupted` and never reaches `Idle` on its own, a **camera power
cycle is the reliable cure** (earlier wedges cleared by a normal power cycle).

**Try the Idle-teardown + XML re-upload before power-cycling** — we've needed a power cycle
only after those both failed.

## Restarting the server leaves a stale one holding :9090

The old process silently keeps winning the port and nothing you change in `server.js` has any
effect. Kill **all** of `node`, `ffmpeg` and `mediamtx` before starting the new server:

```powershell
Stop-Process -Name node,ffmpeg,mediamtx -Force
```

then start again. The camera usually reconnects its SRT caller on its own within ~5–15s; if
the `start` PUT 403s while it's already `Streaming` to your listener, that's fine — verify
the logs instead.

## Camera won't start because the listener isn't up

The PYXIS is an **SRT caller** — it needs the PC's listener alive (or it streams into the
void and wedges). Start the PC side first: open the page (it auto-starts the SRT listener)
or hit `POST /api/stream/start`, *then* start streaming on the camera. The camera's SRT
caller reconnects on its own once the listener is up.

## mediaMTX crashed — does everything come back?

Yes. `server.js` supervises both ffmpeg (0.8s respawn) and mediaMTX (1s respawn). A mediaMTX
crash takes down the WHIP output, which makes ffmpeg exit, and the whole chain respawns and
the camera reconnects. Expected outage: a few seconds. Verified by killing mediaMTX mid-stream.

## Slow or broken browser tabs

- A WS (MSE) client with more than ~4 MB buffered is dropped by the relay — that's
  protection, refresh the tab.
- The one-shot `playerStarted` guard means the player is created once per page load. If the
  transport is misbehaving, refresh the tab rather than toggling the stream.
- Stale tabs: `index.html` cache-busts `app.js?v=N`. If you edit `app.js`, bump `?v=` or
  stale tabs keep running the old JS.

## Firefox shows a delayed picture

Known. Firefox won't ride the WebRTC/WHEP path here and falls back to the delayed MSE view.
Use **Chrome or Edge**. The pages are not tested in Firefox.

## WebRTC won't establish from another machine

- `mediamtx.yml` `webrtcAdditionalHosts` must contain the **PC's IP** (replace the empty
  default `[]` with e.g. `[192.168.1.50]`) if clients on other machines can't connect.
- Windows Firewall: allow TCP `8889` (WHEP handshake) and UDP `8189` (media). Same-PC
  loopback needs no firewall changes.
- On complex networks, prefer a direct PC↔switch↔camera wiring over Wi-Fi for the SRT and
  WebRTC paths.

## Uploading the XML while streaming

Partially applies and kills the session: some fields land instantly (bitrate), others don't
(fps), and the reload tears the session down to `Idle`. Prefer uploading while stopped; the
fps value is also capped by the camera's project rate (e.g. 24p project → a 60 fps profile
still streams 1080p24).
# PYXIS 6K over Ethernet — low-latency browser live view

Free, **no-extra-hardware** live view of your Blackmagic **PYXIS 6K** in **any browser
over plain Ethernet** — no ATEM Streaming Bridge needed. A plug-and-play system that
turns the camera into a sub-half-second **live view in your browser**, built for
wire-focus pulls, camera monitoring and client monitors on set.

- **WebRTC primary** — camera SRT → `mediaMTX` → browser, ~**0.2–0.4s** glass-to-glass
- **fMP4/MSE fallback** — automatic when WebRTC can't be used (~0.4–0.8s)
- **Pure passthrough on the low-latency path** — no re-encode, no fragment buffering
- No hardware decoders, no ATEM boxes, no cloud — just the camera, a PC and a browser (Chrome/Edge)

**What this replaces:** Blackmagic's official route for on-set monitoring is an
**ATEM Streaming Bridge** box. This project does the same job entirely in software on a
Windows PC you already own — free, no purchase, no extra hardware.

```
┌──────────┐     SRT caller      ┌──────────┐  ffmpeg -f whip   ┌──────────┐   WHEP    ┌─────────┐
│  PYXIS   │ ──────────────────► │  PC app  │ ────────────────► │ mediaMTX │ ────────► │ Browser │
│   6K     │  192.168.x.x:9000   │ (Node)   │   (H.264 copy)    │  :8889   │          │  video  │
└──────────┘                     └──────────┘                   └──────────┘          └─────────┘
                                   │   └─ fMP4 pipe:1 ── WS relay ──► MSE fallback
                                   └─ camera REST proxy (/cam/*)
```

## Quick start (Windows; ~10 minutes)

**What you get:** a web page at `http://localhost:9090` that live-views your PYXIS over
the LAN — no internet, no cloud, no SDKs. The app manages ffmpeg + mediaMTX for you and
auto-respawns either if it crashes. Other devices on your network can open the same page
(see *Multiple viewers* below).

1. **Install ffmpeg** (>= 8.x, needs the native `whip` muxer and libsrt):
   `winget install Gyan.FFmpeg` — or download from gyan.dev and make sure `ffmpeg` is on PATH.

2. **Download mediaMTX** v1.20.x (single exe) from
   [github.com/bluenviron/mediamtx/releases](https://github.com/bluenviron/mediamtx/releases)
   and place it at `mediamtx/mediamtx.exe` (it sits next to `mediamtx.yml`).
   `mediamtx.yml` is verified against **v1.20.x**; newer major releases may rename config
   keys — if mediaMTX fails to start, check its changelog before upgrading.

3. **Edit `mediamtx/mediamtx.yml`** → `webrtcAdditionalHosts` is empty by default
   (auto-detected from your PC's NIC). If browser clients can't connect, set your PC's LAN IP,
   e.g. `[192.168.1.50]`.

4. **Install the app**:
   ```
   npm install
   ```

5. **Run it**:
   ```
   $env:CAMERA="PUT_YOUR_CAMERA_IP"   # your camera's IP — this is required
   npm start
   ```

6. **Open the page** in **Chrome or Edge**: `http://localhost:9090`

7. **Configure the camera once** (next section), then start streaming on the camera —
   the page auto-opens the SRT listener and the picture appears on its own.

> The app auto-starts mediaMTX on boot and auto-respawns the SRT listener if the camera
> drops — no other services to babysit.

> **The app never starts or stops the camera.** After the platform XML is uploaded and
> selected, you must press Start/Stream **on the camera** yourself. Once streaming, the
> camera's SRT caller reconnects on its own if the PC listener restarts (see
> [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)).

## Camera setup (one time)

The camera's livestream settings are a "custom platform" XML file. A ready one ships in this
repo as `streaming.xml` ("Pyxis Local SRT", 1080p24, H.264, 16 Mbps, SRT caller to your PC).

1. Power the camera, connect it to the same network as the PC, note its IP.
2. **Edit the SRT target in `streaming.xml`** — the `<url>` value
   `srt://PUT_YOUR_PC_IP:9000?mode=caller` must point at the PC running this app (keep `:9000`
   unless you changed `SRT_PORT`).
3. **Set `fps` in the `<config>` line to whatever frame rate you normally stream at**
   (`fps="24"`, `fps="30"`, …) — the camera caps the live stream to that rate.
4. Upload the platform with curl (self-signed HTTPS cert is expected):
   ```
   curl.exe -ku admin:admin -X PUT -H "Content-Type: application/xml" --data-binary "@streaming.xml" \
     "https://<CAMERA_IP>/control/api/v1/livestreams/customPlatforms/Pyxis_SRT.xml"
   ```
5. On the camera: **Setup → Live Streaming → Platform → "Pyxis Local SRT"**, ensure the
   profile "Streaming High" / server "Primary" is selected (or just follow the camera's
   on-screen streaming flow and pick your custom platform).
6. Open the page in **Chrome or Edge** — it auto-opens the SRT listener on this PC, and the
   browser view goes live on its own as soon as the camera is streaming.

`admin` / `admin` are the PYXIS factory-default REST credentials. Override with
`CAMERA_USER`/`CAMERA_PASS` if you've changed them.

## Configuration (environment variables)

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `9090` | Web page / REST API / WS relay |
| `CAMERA` | *(required — set it)* | Camera IP |
| `CAMERA_USER` | `admin` | Camera REST user |
| `CAMERA_PASS` | `admin` | Camera REST password |
| `FFMPEG` | `ffmpeg` | ffmpeg binary (needs `whip` muxer) |
| `MEDIAMTX` | `mediamtx/mediamtx.exe` | mediaMTX binary |
| `SRT_PORT` | `9000` | SRT listener port (camera's caller URL target) |

## Ports used

| Port | Protocol | Purpose |
|---|---|---|
| `9090` | TCP | page, REST API, WS relay |
| `9000` | SRT | camera → PC ingest |
| `8889` | TCP | mediaMTX HTTP (WHIP in / WHEP out) |
| `8189` | UDP | WebRTC media plane |

Same-PC viewing needs no firewall changes. Viewing from another machine on the LAN: whitelist
`8889`/`8189`/`9000`/`9090` in Windows Firewall.

## Multiple viewers (desktop + laptop, WiFi)

The same page runs on **any device on your network** — a desktop, a laptop on WiFi, a
phone — all watching the PYXIS at once. Each browser runs its **own** WebRTC (WHEP)
session, so there's no channel limit; viewers that can't ride WebRTC auto-fall back to
the slightly-delayed MSE path.

- **Address:** open `http://<PC_IP>:9090` on each device, where `<PC_IP>` is this PC's
  LAN address (same one you put in `streaming.xml` / `mediamtx.yml`, or see
  `http://localhost:9090/api/config`).
- **Firewall:** when viewing from another machine, whitelist `8889`/`8189` (plus `9090`
  for the page) in Windows Firewall — see *Ports used* above.
- **WiFi:** works, but wireless adds jitter. A WiFi viewer may occasionally trip the
  WebRTC health check and slide to the MSE fallback (~0.4–0.8s) until it stabilizes.
  Wired is steadier for the SRT ingest; each WiFi client just monitors.
- **Bandwidth:** each WebRTC viewer is one extra stream from mediaMTX to that browser.
  On a 1 Gb/s switch a handful of 1080p viewers is trivial; over WiFi expect per-client
  headroom to matter more.

## Latency

- **WebRTC path: ~0.2–0.4s glass-to-glass.** The browser rides the live edge at 24.0 fps with
  ~0 frames dropped and ~7ms jitter. Remaining latency is almost entirely SRT buffering
  (both peers) + one decode frame.
- **MSE fallback: ~0.4–0.8s.** Only used when WebRTC isn't available.
- Measure ground truth with a stopwatch / running-clock video in front of the lens.

## Browser support

Use **Chrome or Edge** (both Chromium). Firefox can't ride the WebRTC path here and will show
a noticeably delayed MSE image instead.

## Video only (no audio)

This system is **video-only by design**. The camera is configured to send audio in its SRT
stream, but it is dropped on the PC:

- **WebRTC leg** — the WHIP muxer in ffmpeg refuses to start without a stereo audio track, so
  a *silent* audio track is fed to it; the browser ignores it and only wires the video.
- **MSE fallback leg** — fully silent.

If you ever want the camera's own audio, swap the silent shim for the real track in
`spawnFfmpeg()` (`-map 1:a:0` → `-map 0:a:0`, drop the `anullsrc` input). See
[docs/DESIGN.md](docs/DESIGN.md#2-the-whip-muxer-needs-a-stereo-audio-track).

## Repo layout

```
server.js                  Node app: SRT->WHIP+fMP4 pipeline, supervisors, camera proxy, WS relay
public/                    Browser page (WHEP-first player + MSE fallback)
mediamtx/mediamtx.yml      WebRTC-only mediaMTX config (download mediamtx.exe here)
streaming.xml              Example camera "custom platform" (SRT caller, 1080p24)
docs/DESIGN.md             Deep dive: protocol flow, latency budget, WHIP/SPS-PPS gotchas
docs/TROUBLESHOOTING.md    Wedged streams, black video, restarts, Firefox, and more
```

## Docs

- **[docs/DESIGN.md](docs/DESIGN.md)** — how it works end-to-end: WHEP handshake, why the
  WHIP leg must be `-c:v copy` (and never re-encoded), the silent-stereo-shim requirement,
  the supervisor design, code map.
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — the failure modes we hit and their
  cures: black video / PLI storms, the "stream is active to a different destination" wedge,
  restart procedures, browser gotchas.
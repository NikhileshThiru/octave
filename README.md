# Octave

> Know every word, live.

<img width="1920" height="964" alt="Screenshot 2026-05-26 at 11 15 37 AM" src="https://github.com/user-attachments/assets/084fc73e-c0ed-4d9b-a118-5be2703b2c99" />
<img width="1920" height="962" alt="Screenshot 2026-05-26 at 11 17 28 AM" src="https://github.com/user-attachments/assets/ad80aa05-b8e6-432a-966d-ffd8f3d6187a" />
<img width="1920" height="961" alt="Screenshot 2026-05-26 at 11 23 18 AM" src="https://github.com/user-attachments/assets/dcd9ba2f-0b47-4a27-9931-1205386ee751" />

DEMO:
https://github.com/user-attachments/assets/448873bf-cc24-4621-9496-4a22e8e34fae


## What it does

Octave listens to whatever music is playing in the room, at a concert, on a speaker, through a friend's phone — identifies the song in seconds, and streams perfectly time-synced lyrics in a Spotify-style scrolling view. Hold up your phone, tap Listen, and the right line lights up exactly when the singer hits it.

## How it works

The full pipeline, end to end:

1. **Mic capture (Web Audio API).** The browser captures a 7-second clip through `getUserMedia` → `MediaStreamSource` → a custom `ScriptProcessor` with a subscriber fan-out, downsamples 48 kHz → 16 kHz mono, and emits a WAV blob. A second tap off the same source feeds an `AnalyserNode` that drives the live radial visualizer.

2. **Song identification (ACRCloud).** The WAV is sent to the FastAPI backend, which HMAC-SHA1-signs the request and forwards it to ACRCloud's Identification API. ACRCloud returns the matched song along with a `play_offset_sec` value — *where in the track* the clip was captured from. This offset is the foundation of lyric sync.

3. **Synced lyrics (LRCLIB).** The backend queries [LRCLIB](https://lrclib.net/) (no API key required) with the title/artist returned by ACRCloud, preferring `syncedLyrics` over `plainLyrics`. The LRC-format string is parsed into `{ time, text }[]` and shipped to the frontend.

4. **Playback clock with RTT correction.** The frontend seeds a 100 ms-tick playback clock with ACRCloud's `play_offset_sec` plus the *measured* elapsed time between when the mic capture ended and when the clock is being seeded (covering identify RTT, lyrics RTT, and React reconciliation in one number). This single correction fixes the ~1.5 s drift that would otherwise put every lyric one line off.

5. **FastAPI as a secure proxy.** All third-party calls — ACRCloud signing, LRCLIB search, Spotify oEmbed cover lookup — happen server-side. The frontend never touches the keys; they live in `backend/.env` and never enter the bundle.

6. **Whisper fallback.** If ACRCloud misses three clips in a row (instrumental sections, very noisy rooms, niche tracks), the backend lazy-loads `openai-whisper` and transcribes the latest clip locally. The transcript is then decomposed into 5-word and 3-word candidate queries and fed to LRCLIB's `/search` endpoint — because LRCLIB searches titles and artists, not lyric phrases.

7. **Continuous re-identification.** While the song plays, the frontend re-identifies every 30 seconds to correct any clock drift. A tolerance check (±3.5 s) rejects ACRCloud's chorus-confusion jumps (where the same song is matched to an earlier-occurring near-identical chorus). Instrumental bridges that return no-match are silently absorbed — the clock keeps ticking.

## Mobile

Octave is designed phone-first — the intended use is holding a device up at a concert or in front of a speaker. Every layout and interaction is tuned for that.

- **Responsive listen button.** The visualizer's container size is computed from `window.innerWidth` and scales the inner disc proportionally with a 150 px touch-target floor, so the rays never clip off-screen on a 375 px iPhone SE viewport while still filling the available width on tablets and desktops.
- **Dynamic viewport.** Both the landing page (`min-h-dvh`) and the now-playing view (`height: 100dvh`) use the dynamic viewport unit so the layout doesn't get truncated by Safari's collapsing URL bar or pushed off-screen by the keyboard.
- **Safe-area insets.** The top wordmark, the back button, the Spotify deep-link pill, and the bottom hint text all add `env(safe-area-inset-top/bottom)` padding so nothing collides with the notch or home indicator.
- **Touch tuning.** Body-level `-webkit-tap-highlight-color: transparent` removes the blue iOS tap flash; `overscroll-behavior: none` prevents pull-to-refresh from interrupting a live listen session; the viewport meta tag includes `viewport-fit=cover` and `user-scalable=no` to anchor the layout.
- **Orientation.** Resize *and* `orientationchange` listeners re-measure the visualizer container on rotation so the visualizer reflows cleanly between portrait and landscape.
- **Lyrics view.** The scrolling lyrics column uses a CSS `transform: translateY` instead of `scrollIntoView` — `scrollIntoView` walked up every ancestor and scrolled the document itself on iOS Safari and Firefox, eventually pushing the back button off the top of the screen.
- **Mic permission.** The Listen button is the only interactive surface on the landing page and the only path that calls `getUserMedia`, satisfying browsers' user-gesture requirement on first-tap. The AudioContext is explicitly `resume()`d inside that same gesture so iOS doesn't leave it in a suspended state.

For phone testing on the same Wi-Fi as your dev machine, the easiest path is `ngrok` or `tailscale serve` for HTTPS — browsers only grant mic access on `localhost` or HTTPS origins.

## Tech stack

**Frontend** — React 18, Vite 5, Tailwind CSS 3.4, HTML Canvas (visualizer), Web Audio API (`AudioContext`, `MediaStreamSource`, `ScriptProcessor`, `AnalyserNode`), Fraunces + Manrope (Google Fonts)

**Backend** — Python 3.13, FastAPI, Uvicorn, `requests`, `python-dotenv`, `openai-whisper` (lazy-loaded, `base` model by default)

**Third-party APIs** — ACRCloud Identification API (HMAC-SHA1 signed), LRCLIB (public, no key), Spotify oEmbed (album cover lookup, no key)

**Deployment surface** — runs locally as two processes (`uvicorn` on `:8000`, Vite dev server on `:5173`). Frontend captures mic through `localhost`, so no HTTPS needed for development.

## Run it locally

Requires Python 3.10+ and Node 18+. You'll need ACRCloud Identification API credentials (free tier available at acrcloud.com).

```bash
# 1. Clone
git clone https://github.com/<your-username>/octave.git
cd octave

# 2. Backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure secrets — copy the example and fill in your real ACRCloud keys
cp .env.example .env
# then edit .env with your ACR_HOST, ACR_ACCESS_KEY, ACR_SECRET_KEY

# Start the API (port 8000)
uvicorn main:app --reload

# 3. Frontend (new terminal)
cd ../frontend
npm install
npm run dev
```

Open `http://localhost:5173`, allow microphone access, tap **Listen**, and play a song nearby.

To verify your ACRCloud credentials end-to-end with a real WAV clip:

```bash
cd backend && python test_acr.py path/to/clip.wav
```

## What I learned

The most interesting technical challenge by far was **lyric sync drift**. ACRCloud returns a `play_offset_sec` — but that offset is *as of when the clip was fingerprinted*, not as of when the lyrics start scrolling on the phone. By the time the response reaches the browser, the lyrics endpoint responds, and React commits a re-render, ~1.5 seconds have passed — enough to put every lyric exactly one line off, which is more disorienting than no sync at all. The fix was a two-layer correction: a single elapsed-time measurement at clock seeding to absorb pipeline RTT, plus a continuous re-identification loop every 30 seconds with tolerance-based rejection of ACRCloud's occasional chorus-confusion mismatches.

The **LRCLIB data availability** problem was a different kind of subtle. LRCLIB's `/search` endpoint matches on titles and artists, not on lyric phrases — so when Whisper hands back a transcript like *"there's a lady who's sure all that glitters is gold,"* searching that string verbatim returns nothing. The solution was to fan the transcript into multiple short candidate queries (5-word and 3-word windows) and accept the first hit, which most often surfaces the song by title or by a chorus phrase that happens to overlap.

The **audio pipeline** itself taught me a lot about Web Audio's quirks — `AudioContext` starts suspended under autoplay policy and silently produces no data until `resume()` is called from a user gesture, `AnalyserNode.getByteFrequencyData()` is calibrated against `min/maxDecibels` and can return all-zeros for genuinely quiet rooms, and a `ScriptProcessor` needs to be connected to `ctx.destination` on Safari just to fire its callbacks. Pipelining the listen loop — recording the *next* 7-second clip concurrently with the previous clip's `/identify` round-trip — was a small architectural decision that cut perceived time-to-lock roughly in half.

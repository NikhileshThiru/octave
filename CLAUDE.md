# Octave — agent notes

A two-process app: FastAPI backend (`backend/`) + Vite/React frontend
(`frontend/`). The frontend records 5-second WAV clips from the mic and posts
them to the backend, which fans out to ACRCloud (song ID) and LRCLIB (lyrics),
with a local Whisper fallback after three consecutive misses.

## Running

- Backend: `cd backend && source .venv/bin/activate && uvicorn main:app --reload`
- Frontend: `cd frontend && npm run dev` (Vite dev server on `:5173`)
- Smoke test ACR: `python backend/test_acr.py path/to/sample.wav`

## Key invariants

- `useAudioCapture` always emits **16 kHz mono 16-bit WAV**. Both ACRCloud and
  Whisper accept that without any server-side decoding.
- The miss-counter and Whisper-fallback logic live entirely in `App.jsx`.
  The backend is stateless — don't try to track sessions server-side.
- `LyricsDisplay` renders **all lines at once** and scrolls via
  `scrollIntoView({ behavior: "smooth", block: "center" })` on the active
  line. The lyrics container itself is the scrollable element, not the page.
- `useLyricsSync` ticks every 100 ms and seeds the clock with
  `play_offset_sec` from ACRCloud.
- The noise gate (`utils/noiseDetection.js`) is **a stub that returns false**.
  Don't import Transformers.js or wire a real model — that's intentionally
  out of scope. Keep the signature `(Blob) → Promise<boolean>`.

## Where things live

| Concern                          | File                                         |
|---------------------------------|----------------------------------------------|
| ACRCloud signing                | `backend/acr.py` (`identify_song`)           |
| Spotify cover lookup            | `backend/acr.py` (`fetch_spotify_cover`)     |
| Whisper transcription           | `backend/whisper_fallback.py`                |
| LRCLIB get/search               | `backend/main.py` (`_lrclib_*`)              |
| LRC → `{time,text}[]` parser    | `backend/main.py` _and_ `utils/lrcParser.js` |
| Mic capture & WAV encoding      | `frontend/src/hooks/useAudioCapture.js`      |
| State machine                   | `frontend/src/App.jsx`                       |
| Spotify deep link               | `frontend/src/components/NowPlayingView.jsx` |

## Common pitfalls

- LRCLIB's `/search` endpoint matches on titles/artists, not on full lyric
  phrases. The Whisper fallback shortens the transcript into 5- and 3-word
  candidate queries before falling back to the full string.
- `.env` is read by `python-dotenv` from the **backend working directory**.
  Always launch uvicorn from `backend/` or the credentials won't load.
- The Spotify `spotify://track/<id>` URL only opens the desktop/mobile app.
  `NowPlayingView` falls back to opening `open.spotify.com/track/<id>` after
  a short delay if the user is still on the page.
- ACRCloud rarely returns an album-art URL in its payload. We resolve it via
  the public Spotify oEmbed endpoint after a match, costing ~100 ms.

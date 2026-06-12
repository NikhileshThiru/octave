"""Octave backend.

Exposes two endpoints:

* POST /identify  — accept a multipart audio blob, run ACRCloud, return song
  metadata or 404 on no-match.
* POST /lyrics    — given a title+artist (or free-text query), look up
  synchronized lyrics from LRCLIB and return parsed lines plus the raw LRC.
* POST /fallback  — accept audio, run Whisper, then search LRCLIB by the
  transcribed text. Used by the client after 3 ACR failures.

The frontend handles the "3 strikes" counting; the backend stays stateless.
"""

import logging
from typing import Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import acr
import whisper_fallback

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("octave")

app = FastAPI(title="Octave", version="0.1.0")

# Permissive CORS — this is a local-dev tool intended to be opened from the
# Vite dev server on a phone on the same network. Tighten before any deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

LRCLIB_BASE = "https://lrclib.net/api"


class LyricsLine(BaseModel):
    time: float
    text: str


class LyricsResponse(BaseModel):
    found: bool
    synced: bool
    lines: list[LyricsLine]
    plain: Optional[str] = None
    raw_lrc: Optional[str] = None
    source_title: Optional[str] = None
    source_artist: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/identify")
async def identify(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio payload.")

    # acr uses the sync `requests` client; run it in the threadpool so a slow
    # ACR round trip doesn't stall the event loop. The frontend deliberately
    # overlaps /identify with a speculative /lyrics fetch — blocking here
    # would serialize them server-side and erase that win.
    try:
        result = await run_in_threadpool(acr.identify_song, audio_bytes)
    except Exception as exc:
        log.exception("ACRCloud call failed")
        raise HTTPException(status_code=502, detail=f"ACRCloud error: {exc}") from exc

    if not result:
        # No match — let the client decide whether to retry or fall back.
        raise HTTPException(status_code=404, detail="No match.")

    # Strip the heavy raw payload before returning to the client.
    result.pop("raw", None)

    # Enrich with a real Spotify cover URL if we have a track ID and ACR
    # didn't already provide one.
    if not result.get("album_art_url") and result.get("spotify_track_id"):
        result["album_art_url"] = await run_in_threadpool(
            acr.fetch_spotify_cover, result["spotify_track_id"]
        )

    return result


def _parse_lrc(raw: str) -> list[dict]:
    """Parse an LRC string into a list of {time, text} dicts.

    Tolerates lines with multiple timestamp tags (used for repeated choruses)
    by emitting one entry per timestamp. Skips metadata-only lines like
    [ar:...] and [ti:...].
    """
    import re

    out: list[dict] = []
    pattern = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")

    for raw_line in raw.splitlines():
        matches = list(pattern.finditer(raw_line))
        if not matches:
            continue
        text = pattern.sub("", raw_line).strip()
        for m in matches:
            minutes = int(m.group(1))
            seconds = int(m.group(2))
            frac_str = m.group(3) or "0"
            # Normalize fraction to seconds: "5" → 0.5, "50" → 0.50, "500" → 0.500
            frac = int(frac_str) / (10 ** len(frac_str))
            t = minutes * 60 + seconds + frac
            out.append({"time": t, "text": text})

    out.sort(key=lambda x: x["time"])
    return out


async def _lrclib_get(client: httpx.AsyncClient, **params) -> Optional[dict]:
    """Call LRCLIB /get and return its JSON, or None on 404."""
    try:
        resp = await client.get(f"{LRCLIB_BASE}/get", params=params, timeout=10.0)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPError as exc:
        log.warning("LRCLIB /get failed: %s", exc)
        return None


async def _lrclib_search(client: httpx.AsyncClient, q: str) -> list[dict]:
    try:
        resp = await client.get(f"{LRCLIB_BASE}/search", params={"q": q}, timeout=10.0)
        resp.raise_for_status()
        return resp.json() or []
    except httpx.HTTPError as exc:
        log.warning("LRCLIB /search failed: %s", exc)
        return []


def _pick_best(results: list[dict]) -> Optional[dict]:
    """Choose the best record from a /search response.

    LRCLIB often returns multiple editions of the same song (original album,
    karaoke version, remix entry, etc.). Some have syncedLyrics, some only
    plainLyrics. Prefer a record with synced lyrics, then a record with any
    lyrics at all, then the first result as a last resort.
    """
    if not results:
        return None
    for r in results:
        if r.get("syncedLyrics"):
            return r
    for r in results:
        if r.get("plainLyrics"):
            return r
    return results[0]


def _format_lyrics_response(record: dict) -> LyricsResponse:
    raw_lrc = record.get("syncedLyrics") or ""
    plain = record.get("plainLyrics") or None
    parsed = _parse_lrc(raw_lrc) if raw_lrc else []
    return LyricsResponse(
        found=True,
        synced=bool(parsed),
        lines=[LyricsLine(**line) for line in parsed],
        plain=plain,
        raw_lrc=raw_lrc or None,
        source_title=record.get("trackName"),
        source_artist=record.get("artistName"),
    )


@app.post("/lyrics", response_model=LyricsResponse)
async def lyrics(
    title: str = Form(...),
    artist: str = Form(...),
    album: str = Form(""),
    duration: float = Form(0.0),
):
    async with httpx.AsyncClient() as client:
        params = {"track_name": title, "artist_name": artist}
        if album:
            params["album_name"] = album
        if duration:
            params["duration"] = int(duration)

        record = await _lrclib_get(client, **params)

        # /get is precise but unforgiving — a small album-name or duration
        # mismatch returns 404. Also: even when /get succeeds, the matched
        # record sometimes only has plainLyrics. In both cases, search and
        # prefer a sibling record that actually has synced timing.
        need_search = record is None or not record.get("syncedLyrics")
        if need_search:
            results = await _lrclib_search(client, f"{title} {artist}".strip())
            better = _pick_best(results)
            if better and (record is None or better.get("syncedLyrics")):
                record = better

    if not record:
        return LyricsResponse(found=False, synced=False, lines=[])

    return _format_lyrics_response(record)


@app.post("/fallback", response_model=LyricsResponse)
async def fallback(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio payload.")

    # Whisper inference is CPU-bound and takes seconds — keep it off the
    # event loop or every concurrent request freezes for the duration.
    try:
        transcript = await run_in_threadpool(whisper_fallback.transcribe, audio_bytes)
    except Exception as exc:
        log.exception("Whisper transcription failed")
        raise HTTPException(status_code=500, detail=f"Whisper error: {exc}") from exc

    if not transcript:
        return LyricsResponse(found=False, synced=False, lines=[])

    log.info("Whisper transcript: %r", transcript)

    # LRCLIB's free-text search behaves like a literal title/artist match — it
    # won't find a song by feeding it a full sung line. Try a few shorter
    # variants derived from the transcript and pick the first hit.
    queries = _candidate_queries(transcript)

    async with httpx.AsyncClient() as client:
        for q in queries:
            results = await _lrclib_search(client, q)
            best = _pick_best(results)
            if best:
                return _format_lyrics_response(best)

    return LyricsResponse(found=False, synced=False, lines=[])


def _candidate_queries(transcript: str) -> list[str]:
    """Build progressively shorter search variants from a transcription.

    LRCLIB matches best on phrases that look like titles or short hooks, so
    we try the first 5 words, the longest unique-looking word, etc., before
    falling back to the full string.
    """
    cleaned = " ".join(transcript.replace("\n", " ").split())
    if not cleaned:
        return []
    words = cleaned.split()
    variants: list[str] = []
    if len(words) >= 5:
        variants.append(" ".join(words[:5]))
    if len(words) >= 3:
        variants.append(" ".join(words[:3]))
    variants.append(cleaned)
    # de-dupe while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for v in variants:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out

"""ACRCloud audio recognition client.

Identifies music from a short audio sample using the ACRCloud Identification API.
Returns normalized song metadata including Spotify track ID and current playback
offset (when available), or None when no match is found.
"""

import base64
import hashlib
import hmac
import os
import time
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv()

ACR_HOST = os.getenv("ACR_HOST", "identify-us-west-2.acrcloud.com")
ACR_ACCESS_KEY = os.getenv("ACR_ACCESS_KEY", "")
ACR_SECRET_KEY = os.getenv("ACR_SECRET_KEY", "")

_HTTP_METHOD = "POST"
_HTTP_URI = "/v1/identify"
_DATA_TYPE = "audio"
_SIGNATURE_VERSION = "1"

# ACR fingerprint match confidence is reported per-match on a 0–100 scale.
# Anything below this floor is treated as no-match at the API boundary — at a
# concert these are almost always noise-induced false positives, never real
# matches that the frontend would benefit from seeing. The frontend takes
# things further with 80+ commit-fast and 40–79 corroboration.
MIN_ACCEPT_SCORE = 40.0


def _build_signature(timestamp: str) -> str:
    string_to_sign = "\n".join(
        [_HTTP_METHOD, _HTTP_URI, ACR_ACCESS_KEY, _DATA_TYPE, _SIGNATURE_VERSION, timestamp]
    )
    digest = hmac.new(
        ACR_SECRET_KEY.encode("ascii"),
        string_to_sign.encode("ascii"),
        digestmod=hashlib.sha1,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def _spotify_track_id(metadata: dict) -> Optional[str]:
    external = metadata.get("external_metadata") or {}
    spotify = external.get("spotify") or {}
    track = spotify.get("track") or {}
    return track.get("id")


def _album_art_url(metadata: dict) -> Optional[str]:
    """Best-effort: ACRCloud rarely returns an image URL in its payload."""
    external = metadata.get("external_metadata") or {}
    spotify = external.get("spotify") or {}
    album = spotify.get("album") or {}
    if isinstance(album.get("image"), str):
        return album["image"]
    return None


def fetch_spotify_cover(track_id: str) -> Optional[str]:
    """Resolve a Spotify track ID to a real album cover URL via the public
    oEmbed endpoint. No auth required, but does add ~100 ms of latency, so
    we call it lazily after a successful match.

    The oEmbed endpoint returns a 300x300 thumbnail (`thumbnail_url`). For a
    full-bleed phone-screen background that's far too small — it pixelates
    badly. Spotify image URLs encode size in a hex segment of the filename:
    "00001e02" = 300px, "0000b273" = 640px, "00004851" = 64px. Swapping the
    300px tag for the 640px tag returns the high-res variant from the same
    CDN (no auth, same caching). Verified: HTTP 200, ~120 KB vs ~33 KB.
    """
    if not track_id:
        return None
    try:
        resp = requests.get(
            "https://open.spotify.com/oembed",
            params={"url": f"https://open.spotify.com/track/{track_id}"},
            timeout=5,
        )
        if resp.status_code != 200:
            return None
        url = (resp.json() or {}).get("thumbnail_url")
        if not url:
            return None
        # Upgrade 300px → 640px for full-screen backgrounds.
        return url.replace("ab67616d00001e02", "ab67616d0000b273")
    except requests.RequestException:
        return None


def identify_song(audio_bytes: bytes) -> Optional[dict]:
    """Send an audio sample to ACRCloud and return a normalized result dict.

    Returns None on no-match. Raises requests.HTTPError on network/HTTP failure.
    """
    if not ACR_ACCESS_KEY or not ACR_SECRET_KEY:
        raise RuntimeError("ACR credentials not configured in environment.")

    timestamp = str(int(time.time()))
    signature = _build_signature(timestamp)

    files = {"sample": ("sample.wav", audio_bytes, "audio/wav")}
    data = {
        "access_key": ACR_ACCESS_KEY,
        "sample_bytes": str(len(audio_bytes)),
        "timestamp": timestamp,
        "signature": signature,
        "data_type": _DATA_TYPE,
        "signature_version": _SIGNATURE_VERSION,
    }

    url = f"https://{ACR_HOST}{_HTTP_URI}"
    resp = requests.post(url, files=files, data=data, timeout=15)
    resp.raise_for_status()
    payload = resp.json()

    status = payload.get("status") or {}
    code = status.get("code")
    # 0 = success, 1001 = no result
    if code != 0:
        return None

    music_list = (payload.get("metadata") or {}).get("music") or []
    if not music_list:
        return None

    top = music_list[0]
    score = float(top.get("score") or 0)
    if score < MIN_ACCEPT_SCORE:
        # ACR returned something but the fingerprint similarity is too low to
        # trust. Caller treats this as no-match.
        return None

    title = top.get("title") or ""
    artists = top.get("artists") or []
    artist_name = ", ".join(a.get("name", "") for a in artists if a.get("name"))
    album = (top.get("album") or {}).get("name", "")
    spotify_id = _spotify_track_id(top)
    # play_offset_ms = where the matched sample is positioned in the track
    play_offset_ms = top.get("play_offset_ms") or 0
    duration_ms = top.get("duration_ms") or 0

    return {
        "title": title,
        "artist": artist_name,
        "album": album,
        "album_art_url": _album_art_url(top),
        "spotify_track_id": spotify_id,
        "score": score,
        "play_offset_sec": play_offset_ms / 1000.0,
        "duration_sec": duration_ms / 1000.0 if duration_ms else None,
        "raw": top,
    }

"""Whisper-based speech fallback for unidentified music.

When ACRCloud fails to recognize a clip after several attempts, we run the
audio through a small local Whisper model to transcribe whatever lyrics or
speech are audible. The transcription is then used as a free-text query
against LRCLIB to try to find a matching song.
"""

import os
import tempfile
from typing import Optional

_model = None


def _get_model():
    """Lazily load the Whisper model on first use.

    The "base" model is a reasonable tradeoff between latency and accuracy on
    short clips. It downloads ~150 MB the first time it runs.
    """
    global _model
    if _model is None:
        import whisper  # imported lazily so the backend can start without it
        model_name = os.getenv("WHISPER_MODEL", "base")
        _model = whisper.load_model(model_name)
    return _model


def transcribe(audio_bytes: bytes) -> Optional[str]:
    """Transcribe an audio clip and return the cleaned text, or None if empty."""
    if not audio_bytes:
        return None

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        model = _get_model()
        result = model.transcribe(tmp_path, fp16=False)
        text = (result.get("text") or "").strip()
        return text or None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

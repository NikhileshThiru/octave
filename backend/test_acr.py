"""Test ACRCloud identification end-to-end.

Usage:
    python test_acr.py path/to/clip.wav

Reads a real audio sample, sends it to ACRCloud via acr.identify_song, and
prints the normalized result. Exits non-zero if no match is returned.
"""

import json
import sys
from pathlib import Path

import acr


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python test_acr.py <audio_file>")
        return 2

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"File not found: {path}")
        return 2

    audio_bytes = path.read_bytes()
    print(f"Sending {len(audio_bytes)} bytes from {path.name} to ACRCloud...")

    try:
        result = acr.identify_song(audio_bytes)
    except Exception as exc:
        print(f"ACRCloud call raised: {exc!r}")
        return 1

    if not result:
        print("No match.")
        return 1

    result.pop("raw", None)
    print("MATCH:")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

import { useEffect, useRef, useState } from "react";
import { activeLineIndex } from "../utils/lrcParser.js";

/**
 * Drives a monotonically increasing playback clock and returns the index of
 * the currently active lyric line.
 *
 * The clock is seeded with `startOffsetSec` (the ACRCloud play_offset_sec —
 * "this sample was found N seconds into the song") and advances in real time
 * from when sync starts. Tick rate is 100 ms so the active line updates
 * smoothly without burning CPU.
 *
 * The component owning this hook can pause/resume by toggling `running`.
 */

export function useLyricsSync({ lines, startOffsetSec, running }) {
  const [currentIndex, setCurrentIndex] = useState(-1);

  const startWallRef = useRef(null);
  const startOffsetRef = useRef(startOffsetSec || 0);

  useEffect(() => {
    if (!running) return undefined;

    startWallRef.current = performance.now();
    startOffsetRef.current = startOffsetSec || 0;

    const tick = () => {
      const elapsed = (performance.now() - startWallRef.current) / 1000;
      const pos = startOffsetRef.current + elapsed;
      // Functional update so unchanged ticks bail out of re-rendering —
      // otherwise the whole lyrics tree re-renders 10×/sec for nothing.
      const idx = activeLineIndex(lines, pos);
      setCurrentIndex((prev) => (prev === idx ? prev : idx));
    };

    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [lines, startOffsetSec, running]);

  return { currentIndex };
}

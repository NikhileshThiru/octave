import { useLayoutEffect, useRef, useState } from "react";

/**
 * Spotify-style lyrics column, but rendered with a CSS transform instead of
 * actual scroll.
 *
 * Why no scroll: `scrollIntoView` walks up every ancestor and scrolls each
 * scrollable container — including the window. In Firefox especially, this
 * was nudging the document upward by a few pixels per tick, eventually
 * pushing the back button + "Now Playing" header off the top of the screen.
 *
 * The fix: render all lyrics in an absolutely-positioned inner block inside
 * an `overflow-hidden` container, and translate the inner block so the
 * active line sits at vertical center. No scroll containers exist, so
 * nothing for the browser to over-scroll, and the page chrome can't drift.
 *
 * The line sizing/dimming behavior is unchanged from the scroll-based
 * version — active line large + white, ±4 lines progressively dim.
 */

const FADE = [1.0, 0.55, 0.35, 0.2, 0.1];
const SIZE = [
  "font-display text-[26px] md:text-[34px] leading-[1.18] font-medium tracking-tight",
  "text-[17px] md:text-[20px] leading-snug font-medium",
  "text-[15px] md:text-[17px] leading-snug",
  "text-[14px] md:text-[15px] leading-snug",
  "text-[13px] md:text-[14px] leading-snug",
];

// `accent` is the album-palette primary as [r,g,b] (or null). It only tints
// the active line's outer glow — the text itself stays bone for legibility.
export default function LyricsDisplay({ lines, currentIndex, plain, accent }) {
  const containerRef = useRef(null);
  const lineRefs = useRef([]);
  const [translateY, setTranslateY] = useState(0);

  // Keep refs array in sync with line count without holding old DOM nodes.
  lineRefs.current.length = lines ? lines.length : 0;

  useLayoutEffect(() => {
    if (!lines || lines.length === 0) return;
    if (currentIndex < 0) {
      setTranslateY(0);
      return;
    }
    const activeEl = lineRefs.current[currentIndex];
    const container = containerRef.current;
    if (!activeEl || !container) return;

    const containerHeight = container.clientHeight;
    const activeTop = activeEl.offsetTop;
    const activeHeight = activeEl.clientHeight;
    // Position the active line at the vertical center of the container.
    setTranslateY(containerHeight / 2 - activeTop - activeHeight / 2);
  }, [currentIndex, lines]);

  // Plain-text fallback (no timing data).
  if ((!lines || lines.length === 0) && plain) {
    return (
      <div
        className="lyrics-scroll lyric-fade flex-1 overflow-y-auto px-8 md:px-14 pb-16 pt-8 text-center md:text-left text-bone/90 whitespace-pre-line leading-relaxed text-[16px]"
        style={{
          textShadow: "0 1px 2px rgba(0,0,0,0.85), 0 2px 12px rgba(0,0,0,0.55)",
        }}
      >
        <div className="text-[10px] uppercase tracking-widest2 text-bone/50 mb-5">
          Unsynced lyrics
        </div>
        {plain}
      </div>
    );
  }

  if (!lines || lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-bone/55 px-8 text-center">
        <div>
          <div className="text-[10px] uppercase tracking-widest2 text-bone/35 mb-3">
            No lyrics available
          </div>
          <div className="font-display italic text-bone/75 text-[20px]">
            Just enjoy the song.
          </div>
        </div>
      </div>
    );
  }

  const activeGlow = accent
    ? `rgba(${accent[0]},${accent[1]},${accent[2]},0.38)`
    : "rgba(125,211,252,0.3)";

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden lyric-fade"
    >
      <div
        className="absolute left-0 right-0 px-7 md:px-14 lg:px-20"
        style={{
          transform: `translateY(${translateY}px)`,
          transition: "transform 600ms cubic-bezier(0.4, 0, 0.2, 1)",
          willChange: "transform",
        }}
      >
        {lines.map((line, i) => {
          const distance = Math.abs(i - currentIndex);
          const opacity = distance < FADE.length ? FADE[distance] : 0.06;
          const sizeClass =
            distance < SIZE.length ? SIZE[distance] : "text-[12px] md:text-[13px]";
          const isActive = i === currentIndex;

          return (
            <p
              key={`${i}-${line.time}`}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={[
                "text-center md:text-left my-3 text-bone transition-all duration-500 ease-out",
                sizeClass,
              ].join(" ")}
              style={{
                opacity,
                textShadow: isActive
                  ? `0 1px 2px rgba(0,0,0,0.85), 0 2px 18px rgba(0,0,0,0.55), 0 2px 24px ${activeGlow}`
                  : "0 1px 2px rgba(0,0,0,0.85), 0 2px 12px rgba(0,0,0,0.55)",
              }}
            >
              {line.text || "♪"}
            </p>
          );
        })}
      </div>
    </div>
  );
}

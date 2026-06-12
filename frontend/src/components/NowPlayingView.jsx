import { useEffect, useMemo, useState } from "react";
import LyricsDisplay from "./LyricsDisplay.jsx";
import SongInfo from "./SongInfo.jsx";
import { useLyricsSync } from "../hooks/useLyricsSync.js";
import { extractPalette } from "../utils/paletteExtract.js";

/**
 * Full-screen "now playing" view.
 *
 * Composition, top → bottom (mobile) / left → right (≥ md):
 *   - Aurora gradient backdrop + film grain (same as the landing page, so
 *     the visual identity carries through across screens).
 *   - Adaptive aurora tint: the album cover's dominant colors, extracted
 *     client-side, fade in over the base aurora ~1.5 s after the match.
 *     That slow color bloom doubles as the "song locked in" moment.
 *   - Absolute back button, top-left, guaranteed visible.
 *   - Cover / title / progress panel — stacked on top for phones, a left
 *     column on desktop so wide viewports get a two-pane editorial layout
 *     instead of a stretched phone column.
 *   - Lyrics column (transform-based, see LyricsDisplay).
 *   - Spotify deep-link pill — bottom-center on phones, under the song
 *     info on desktop.
 *
 * The container uses `100dvh` for the visible viewport so mobile browsers
 * with chrome don't push the back button off-screen.
 */
export default function NowPlayingView({ song, lyrics, onBack }) {
  const coverUrl = useMemo(() => song.album_art_url || null, [song]);

  // Dominant-color palette from the cover; null until extracted (or forever,
  // for monochrome covers / CORS-tainted images — the default aurora stays).
  const [palette, setPalette] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setPalette(null);
    if (!coverUrl) return undefined;
    extractPalette(coverUrl).then((p) => {
      if (!cancelled) setPalette(p);
    });
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  const accent = palette?.primary || null;

  const { currentIndex } = useLyricsSync({
    lines: lyrics?.lines || [],
    startOffsetSec: song.play_offset_sec || 0,
    running: true,
  });

  const spotifyHref = song.spotify_track_id
    ? `spotify://track/${song.spotify_track_id}`
    : null;
  const spotifyWebHref = song.spotify_track_id
    ? `https://open.spotify.com/track/${song.spotify_track_id}`
    : null;

  const tintStyle = palette
    ? {
        background: [
          `radial-gradient(ellipse 55% 45% at 25% 30%, ${rgba(palette.primary, 0.5)}, transparent 65%)`,
          `radial-gradient(ellipse 60% 50% at 75% 70%, ${rgba(palette.secondary, 0.42)}, transparent 65%)`,
          `radial-gradient(ellipse 70% 45% at 50% 110%, ${rgba(palette.primary, 0.24)}, transparent 60%)`,
        ].join(", "),
      }
    : undefined;

  const coverGlow = accent ? rgba(accent, 0.35) : "rgba(56,189,248,0.18)";

  return (
    <div
      className="fixed top-0 left-0 right-0 text-bone overflow-hidden"
      style={{ height: "100dvh" }}
    >
      {/* Atmospheric backdrop — reuses landing aesthetic so the app feels
          coherent across screens. Aurora-bg + grain are fixed-positioned
          via their own classes, so they fill the viewport regardless of
          where they appear in the tree. */}
      <div className="aurora-bg" />
      <div className={`aurora-tint${palette ? " on" : ""}`} style={tintStyle} />
      <div className="grain" />

      {/* Back button — absolutely positioned, top-left. Lifted out of the
          flex flow on purpose so no sibling can push it off-screen. */}
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="absolute z-20 w-11 h-11 flex items-center justify-center rounded-full bg-black/55 hover:bg-black/75 border border-white/25 text-white transition-all shadow-[0_8px_24px_-8px_rgba(0,0,0,0.55)] active:scale-95 backdrop-blur-md"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 1rem)",
          left: "1rem",
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* Content — column on phones, two panes on desktop */}
      <div className="relative z-10 flex flex-col md:flex-row h-full">
        {/* Song panel: cover, metadata, progress, (desktop) Spotify pill */}
        <div className="flex flex-col shrink-0 md:w-[40%] md:max-w-[440px] md:h-full md:justify-center md:pl-14 lg:pl-20 md:pr-2">
          {/* Mobile-only spacer that clears the absolute back button */}
          <div
            className="shrink-0 md:hidden"
            style={{
              paddingTop: "calc(env(safe-area-inset-top, 0px) + 4.25rem)",
            }}
          />

          {/* Album cover — sharp, square, fully visible */}
          {coverUrl && (
            <div className="flex justify-center md:justify-start px-8 md:px-0 shrink-0 mb-3 md:mb-6 animate-cover-in">
              <div
                className="w-full max-w-[200px] md:max-w-[300px] aspect-square rounded-xl overflow-hidden border border-white/10"
                style={{
                  boxShadow: `0 30px 60px -15px rgba(0,0,0,0.7), 0 0 80px -20px ${coverGlow}`,
                  transition: "box-shadow 1600ms ease",
                }}
              >
                <img
                  src={coverUrl}
                  alt={`${song.title} album art`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              </div>
            </div>
          )}

          <div className="animate-fade-up" style={{ animationDelay: "90ms" }}>
            <SongInfo title={song.title} artist={song.artist} album={song.album} />
          </div>

          <ProgressBar
            offsetSec={song.play_offset_sec || 0}
            durationSec={song.duration_sec}
            accent={accent}
          />

          {spotifyHref && (
            <div
              className="hidden md:block mt-7 animate-fade-up"
              style={{ animationDelay: "240ms" }}
            >
              <SpotifyPill href={spotifyHref} webHref={spotifyWebHref} />
            </div>
          )}
        </div>

        {/* Lyrics pane */}
        <div
          className="flex-1 flex min-h-0 animate-fade-up"
          style={{ animationDelay: "160ms" }}
        >
          <LyricsDisplay
            lines={lyrics?.lines || []}
            currentIndex={currentIndex}
            plain={lyrics?.plain}
            accent={accent}
          />
        </div>

        {/* Mobile Spotify pill, pinned under the lyrics */}
        {spotifyHref && (
          <div
            className="md:hidden flex justify-center shrink-0 px-6 pt-2 animate-fade-up"
            style={{
              animationDelay: "240ms",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)",
            }}
          >
            <SpotifyPill href={spotifyHref} webHref={spotifyWebHref} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Thin song-progress bar driven entirely by a CSS transition: seed the fill
 * at the current position, then animate to 100% over the remaining seconds.
 * Zero ticks, zero re-renders; re-id corrections replace `song`, which
 * changes `offsetSec` and re-seeds it.
 */
function ProgressBar({ offsetSec, durationSec, accent }) {
  const [filling, setFilling] = useState(false);

  useEffect(() => {
    setFilling(false);
    // Double rAF so the seeded width paints before the transition starts.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setFilling(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [offsetSec, durationSec]);

  if (!durationSec || durationSec <= 0) return null;

  const startPct = Math.min(100, Math.max(0, (offsetSec / durationSec) * 100));
  const remainingSec = Math.max(0, durationSec - offsetSec);
  const fill = accent ? rgba(accent, 0.85) : "rgba(245,242,236,0.7)";

  return (
    <div
      className="px-10 md:px-0 mt-1 mb-1 animate-fade-up"
      style={{ animationDelay: "140ms" }}
    >
      <div className="h-[3px] rounded-full bg-white/10 overflow-hidden max-w-[260px] md:max-w-[300px] mx-auto md:mx-0">
        <div
          className="h-full rounded-full"
          style={{
            width: filling ? "100%" : `${startPct}%`,
            transition: filling ? `width ${remainingSec}s linear` : "none",
            background: fill,
          }}
        />
      </div>
    </div>
  );
}

function SpotifyPill({ href, webHref }) {
  return (
    <a
      href={href}
      onClick={() => {
        // The spotify:// scheme only resolves if the app is installed; if
        // we're still visible after a beat, open the web player instead.
        if (webHref) {
          setTimeout(() => {
            if (!document.hidden) {
              window.open(webHref, "_blank", "noopener");
            }
          }, 700);
        }
      }}
      className="inline-flex items-center gap-3 pl-3 pr-4 py-2.5 rounded-full bg-black/55 hover:bg-black/75 border border-white/20 text-white text-[13px] font-medium tracking-wide transition-all active:scale-[0.98] backdrop-blur-md"
    >
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[#1DB954] opacity-60 animate-ping" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#1DB954]" />
      </span>
      <span>Open in Spotify</span>
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-70"
      >
        <path d="M7 17L17 7" />
        <path d="M8 7h9v9" />
      </svg>
    </a>
  );
}

function rgba([r, g, b], a) {
  return `rgba(${r},${g},${b},${a})`;
}

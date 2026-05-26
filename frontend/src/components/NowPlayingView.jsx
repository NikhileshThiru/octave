import { useMemo } from "react";
import LyricsDisplay from "./LyricsDisplay.jsx";
import SongInfo from "./SongInfo.jsx";
import { useLyricsSync } from "../hooks/useLyricsSync.js";

/**
 * Full-screen "now playing" view — Option 3 layout.
 *
 * Composition, top → bottom:
 *   - Aurora gradient backdrop + film grain (same as the landing page, so
 *     the visual identity carries through across screens).
 *   - Absolute back button, top-left, guaranteed visible.
 *   - Centered album cover as a real <img> in a rounded card — never
 *     cropped, never stretched. Replaces the full-bleed background.
 *   - Title / artist / album block.
 *   - Lyrics column (transform-based, see LyricsDisplay).
 *   - Spotify deep-link pill, bottom-center.
 *
 * The container uses `100dvh` for the visible viewport so mobile browsers
 * with chrome don't push the back button off-screen.
 */
export default function NowPlayingView({ song, lyrics, onBack }) {
  const coverUrl = useMemo(() => song.album_art_url || null, [song]);

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

      {/* Content column */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Top spacer that clears the absolute back button */}
        <div
          className="shrink-0"
          style={{
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 4.25rem)",
          }}
        />

        {/* Centered album cover — sharp, square, fully visible */}
        {coverUrl && (
          <div className="flex justify-center px-8 shrink-0 mb-3 animate-fade-up">
            <div
              className="w-full max-w-[200px] aspect-square rounded-xl overflow-hidden border border-white/10"
              style={{
                boxShadow:
                  "0 30px 60px -15px rgba(0,0,0,0.7), 0 0 80px -20px rgba(56,189,248,0.18)",
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

        <SongInfo title={song.title} artist={song.artist} album={song.album} />

        <LyricsDisplay
          lines={lyrics?.lines || []}
          currentIndex={currentIndex}
          plain={lyrics?.plain}
        />

        {spotifyHref && (
          <div
            className="flex justify-center shrink-0 px-6 pt-2"
            style={{
              paddingBottom:
                "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)",
            }}
          >
            <a
              href={spotifyHref}
              onClick={() => {
                if (spotifyWebHref) {
                  setTimeout(() => {
                    if (!document.hidden) {
                      window.open(spotifyWebHref, "_blank", "noopener");
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
          </div>
        )}
      </div>
    </div>
  );
}

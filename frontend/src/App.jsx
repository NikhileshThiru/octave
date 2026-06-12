import { useCallback, useEffect, useRef, useState } from "react";
import ListenButton from "./components/ListenButton.jsx";
import NowPlayingView from "./components/NowPlayingView.jsx";
import { useAudioCapture } from "./hooks/useAudioCapture.js";
import { checkIfTooNoisy } from "./utils/noiseDetection.js";

/**
 * Top-level controller.
 *
 * State machine:
 *   idle  →  listening  →  playing
 *
 * The listen loop is the part with all the moving parts:
 *
 *   - Pipelined recording: while one clip is being processed by /identify,
 *     the next 5-second clip is already being captured. Hides the ~1.5 s
 *     network RTT on every attempt past the first.
 *
 *   - Score-aware commit:
 *       score ≥ 80           → commit immediately (clean signal)
 *       40 ≤ score < 80     → corroborate (best 2-of-3 agreement)
 *       score < 40          → rejected at the backend, treated as 404
 *
 *   - Speculative lyrics fetch: the moment a candidate is established,
 *     we start pulling its lyrics in the background. If corroboration
 *     commits to that song, lyrics are already loaded — saves ~300 ms.
 *
 *   - Whisper fallback after 3 consecutive ACR 404s (score-filter rejects
 *     count as 404s here, since the user gets nothing usable from them).
 *
 *   - Re-identification effect (further down) corrects drift every 30 s
 *     while playing, validated against the running clock to filter out
 *     ACR chorus-confusion jumps.
 */

// Empty string by default → relative URLs like `/identify`, which the Vite
// dev server proxies to uvicorn on :8000 (see vite.config.js). This keeps
// the frontend and backend on the same origin so a single ngrok / Tailscale
// tunnel serves both on a phone. Override with VITE_API_BASE for prod
// deployments that put the API on a different host.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";
// 7 s clips (vs 5 s) trade ~2 s of time-to-lock for meaningfully better
// noise tolerance — ACR fingerprints more reliably on longer windows. 5 s
// is the floor of ACR's recommended range; 7 s is comfortably inside it.
const CLIP_SECONDS = 7;
// In a noisy room ACR can need several attempts before catching a clean
// section, so we let it try longer before falling back / giving up.
const MAX_MISSES_BEFORE_FALLBACK = 5;
const HARD_GIVE_UP_AFTER = 15;
const GAP_MS = 100;

const COMMIT_FAST_SCORE = 80;       // ≥ this → eligible for commit (still validated)
const POSITION_TOLERANCE_SEC = 2.0; // commit-fast validation: how far the second
                                    // clip's offset may diverge from the expected
                                    // ~5s progression before we treat the first
                                    // match as a wrong-position chorus mismatch.
const REID_INTERVAL_MS = 30000;
const REID_ACCEPT_TOLERANCE_SEC = 3.5;
// In the corroborate band, even a "different song" re-id only switches if
// the new candidate scores at least this — protects against mid-track
// spurious matches during noisy stretches.
const REID_SWITCH_MIN_SCORE = 70;

export default function App() {
  const [state, setState] = useState("idle"); // idle | listening | playing
  const [song, setSong] = useState(null);
  const [lyrics, setLyrics] = useState(null);
  const [tooNoisy, setTooNoisy] = useState(false);
  const [hardError, setHardError] = useState(null);
  // Mirrors attemptCountRef so the status line can stage its messaging
  // ("Listening…" → "Still listening…") as attempts accumulate.
  const [attempts, setAttempts] = useState(0);
  const [fallbackActive, setFallbackActive] = useState(false);

  const { error: micError, analyser, recordClip, stop: stopMic } = useAudioCapture();

  const runningRef = useRef(false);
  const missCountRef = useRef(0);
  const attemptCountRef = useRef(0);

  // Responsive sizing for the listen button + visualizer. The component's
  // default 520px would overflow narrow phone viewports (375 px iPhone SE,
  // 393 px iPhone Pro). We cap to the viewport width with a small horizontal
  // gutter and scale the inner button proportionally with a touch-target
  // floor so it never shrinks below ~150 px.
  const [vizSize, setVizSize] = useState(() =>
    typeof window !== "undefined"
      ? Math.min(520, window.innerWidth - 16)
      : 520
  );
  useEffect(() => {
    const onResize = () =>
      setVizSize(Math.min(520, window.innerWidth - 16));
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  const btnSize = Math.max(150, Math.round(vizSize * (188 / 520)));

  // Mirror of `song` for the re-identification loop (which runs in an async
  // closure and needs the latest value without re-subscribing).
  const songRef = useRef(null);
  const reidActiveRef = useRef(false);
  const reidTimerRef = useRef(null);

  // Mirror of the lyric clock's seed. Used to validate re-id corrections
  // (reject jumps > REID_ACCEPT_TOLERANCE_SEC — almost always chorus
  // confusion by ACR).
  const seedOffsetRef = useRef(0);
  const seedWallMsRef = useRef(0);

  const seedClock = useCallback((correctedOffsetSec) => {
    seedOffsetRef.current = correctedOffsetSec;
    seedWallMsRef.current = performance.now();
  }, []);

  const expectedPositionSec = useCallback(() => {
    return seedOffsetRef.current + (performance.now() - seedWallMsRef.current) / 1000;
  }, []);

  const handleStop = useCallback(() => {
    runningRef.current = false;
    reidActiveRef.current = false;
    if (reidTimerRef.current) {
      clearTimeout(reidTimerRef.current);
      reidTimerRef.current = null;
    }
    setState("idle");
    setTooNoisy(false);
    setAttempts(0);
    setFallbackActive(false);
    missCountRef.current = 0;
    attemptCountRef.current = 0;
    stopMic();
  }, [stopMic]);

  // handleMatch can accept a prefetched lyrics promise (from speculative
  // fetch). If absent it fetches lyrics fresh. Either way, the correction
  // applied to play_offset_sec is the true elapsed time from "audio capture
  // ended" to "we're seeding the clock right now" — covering /identify RTT,
  // /lyrics RTT, and React reconciliation in one shot.
  const handleMatch = useCallback(
    async (matched, recordEndMs, prefetchedLyricsResp = null) => {
      let lyricsData = { found: false, synced: false, lines: [], plain: null };
      try {
        const resp = prefetchedLyricsResp
          ? await prefetchedLyricsResp
          : await fetch(`${API_BASE}/lyrics`, {
              method: "POST",
              body: lyricsForm(matched),
            });
        if (resp && resp.ok) lyricsData = await resp.json();
      } catch {
        // keep the empty default
      }

      const correctionSec = recordEndMs
        ? (performance.now() - recordEndMs) / 1000
        : 0;
      const corrected = {
        ...matched,
        play_offset_sec: (matched.play_offset_sec || 0) + correctionSec,
      };
      songRef.current = corrected;
      seedClock(corrected.play_offset_sec);
      setSong(corrected);
      setLyrics(lyricsData);
      setState("playing");
    },
    [seedClock]
  );

  const runListenLoop = useCallback(async () => {
    runningRef.current = true;
    missCountRef.current = 0;
    attemptCountRef.current = 0;
    setAttempts(0);
    setFallbackActive(false);
    setHardError(null);
    setState("listening");

    // Corroboration state. Each entry: { song, recordEndMs, score }.
    // A new clip's match commits the loop if it agrees with any prior
    // entry. We never keep more than the last few — beyond 3, no two agreed
    // and we reset.
    const candidates = [];
    let speculativeLyrics = null; // { song, promise } — for the first candidate

    // Pipelined recording: while we wait for /identify on the current clip,
    // the next clip is already capturing. `pendingClip` holds that Promise.
    let pendingClip = null;

    const recordNext = () => recordClip(CLIP_SECONDS).catch(() => null);

    while (runningRef.current) {
      // Get the clip we're about to process (from the pipeline or fresh).
      let clip;
      let recordEndMs;
      try {
        if (pendingClip) {
          clip = await pendingClip;
          pendingClip = null;
        } else {
          clip = await recordClip(CLIP_SECONDS);
        }
        recordEndMs = performance.now();
      } catch {
        runningRef.current = false;
        setState("idle");
        return;
      }

      if (!runningRef.current || !clip) return;

      // Kick off the NEXT recording immediately, in parallel with the
      // /identify call below. If we commit on the current clip, the pending
      // one resolves into the void (its subscriber cleans itself up).
      if (runningRef.current) pendingClip = recordNext();

      const noisy = await checkIfTooNoisy(clip);
      if (noisy) {
        setTooNoisy(true);
        await sleep(2500);
        setTooNoisy(false);
        continue;
      }

      attemptCountRef.current += 1;
      setAttempts(attemptCountRef.current);

      let resp;
      try {
        resp = await fetch(`${API_BASE}/identify`, {
          method: "POST",
          body: formDataWith("file", clip, "clip.wav"),
        });
      } catch {
        // Network blip — keep looping silently.
        await sleep(GAP_MS);
        continue;
      }

      if (!runningRef.current) return;

      if (resp.ok) {
        const matched = await resp.json();
        const score = Number(matched.score) || 0;

        // ── High-confidence path: validate position before committing ──
        // ACR returning the right *song* doesn't guarantee the right
        // *position* — for tracks with repeated choruses or near-identical
        // verses, ACR can match a clip to an earlier occurrence. We confirm
        // by using the already-pipelined next clip: its play_offset_sec
        // should land ~5 seconds further along the song than this one's.
        if (score >= COMMIT_FAST_SCORE) {
          // Kick off the clip AFTER the validation clip in parallel, so
          // pipelining is preserved if validation fails and we have to keep
          // listening.
          const nextPipelined = runningRef.current ? recordNext() : null;

          let clip2 = null;
          if (pendingClip) {
            try {
              clip2 = await pendingClip;
            } catch {
              clip2 = null;
            }
            pendingClip = null;
          }
          if (!runningRef.current) return;

          // No pipelined validation clip available (very rare — only if the
          // pipeline call rejected). Commit on the single clip as a fallback;
          // re-id can still catch errors later.
          if (!clip2) {
            runningRef.current = false;
            const prefetched =
              speculativeLyrics && isSameSong(speculativeLyrics.song, matched)
                ? speculativeLyrics.promise
                : null;
            await handleMatch(matched, recordEndMs, prefetched);
            return;
          }

          const recordEndMs2 = performance.now();
          let resp2;
          try {
            resp2 = await fetch(`${API_BASE}/identify`, {
              method: "POST",
              body: formDataWith("file", clip2, "clip.wav"),
            });
          } catch {
            resp2 = null;
          }
          if (!runningRef.current) return;

          if (resp2 && resp2.ok) {
            const matched2 = await resp2.json();
            if (isSameSong(matched, matched2)) {
              const expectedProgressSec =
                (recordEndMs2 - recordEndMs) / 1000;
              const actualProgressSec =
                (matched2.play_offset_sec || 0) -
                (matched.play_offset_sec || 0);
              const progressDelta = Math.abs(
                actualProgressSec - expectedProgressSec
              );

              if (progressDelta <= POSITION_TOLERANCE_SEC) {
                // Positions agree → commit with the freshest data (clip 2),
                // which gives the most accurate play_offset for clock seeding.
                runningRef.current = false;
                const prefetched =
                  speculativeLyrics &&
                  isSameSong(speculativeLyrics.song, matched2)
                    ? speculativeLyrics.promise
                    : null;
                await handleMatch(matched2, recordEndMs2, prefetched);
                return;
              }
            }
            // Different song on the validation clip (or no isSameSong match)
            // is also a fail — signal was unstable.
          }

          // Validation didn't confirm. Reset the corroboration state and
          // keep listening with the next pipelined clip already in flight.
          pendingClip = nextPipelined;
          candidates.length = 0;
          speculativeLyrics = null;
          attemptCountRef.current += 1; // count the validation /identify call
          setAttempts(attemptCountRef.current);
          // fall through to the end-of-iteration give-up check + gap
        } else {

        // ── Corroborate band (40–79): require 2-of-N agreement ──
        // Does this match agree with any prior candidate? If so, commit.
        const agreeing = candidates.find((c) => isSameSong(c.song, matched));
        if (agreeing) {
          runningRef.current = false;
          // Use the freshest of the agreeing pair for clock-accuracy, but
          // prefer the higher-scored one's metadata if it differs.
          const winner = score >= agreeing.score ? matched : agreeing.song;
          const prefetched =
            speculativeLyrics && isSameSong(speculativeLyrics.song, winner)
              ? speculativeLyrics.promise
              : null;
          await handleMatch(winner, recordEndMs, prefetched);
          return;
        }

        candidates.push({ song: matched, recordEndMs, score });
        missCountRef.current = 0; // a borderline hit isn't a miss for Whisper purposes

        // Start the speculative lyrics fetch on the very first candidate
        // of a corroboration cycle. If a later vote disagrees and wins,
        // we just waste one LRCLIB call (cheap).
        if (candidates.length === 1) {
          speculativeLyrics = {
            song: matched,
            promise: fetch(`${API_BASE}/lyrics`, {
              method: "POST",
              body: lyricsForm(matched),
            }).catch(() => null),
          };
        }

        // Three candidates, none agreed → reset and start fresh.
        if (candidates.length >= 3) {
          candidates.length = 0;
          speculativeLyrics = null;
        }
        } // end else (corroborate band)
      } else if (resp.status === 404) {
        // ACR returned no match (or backend rejected by score floor).
        missCountRef.current += 1;
        if (missCountRef.current >= MAX_MISSES_BEFORE_FALLBACK) {
          // Whisper takes a few seconds — tell the user we're doing
          // something different rather than leaving "Listening…" up.
          setFallbackActive(true);
          try {
            const fbResp = await fetch(`${API_BASE}/fallback`, {
              method: "POST",
              body: formDataWith("file", clip, "clip.wav"),
            });
            if (fbResp.ok) {
              const fbData = await fbResp.json();
              if (fbData.found) {
                runningRef.current = false;
                // Whisper matches don't get re-identified (ACR couldn't
                // fingerprint them in the first place). Free the mic.
                stopMic();
                const fallbackSong = {
                  title: fbData.source_title || "Unknown title",
                  artist: fbData.source_artist || "Unknown artist",
                  album: "",
                  album_art_url: null,
                  spotify_track_id: null,
                  play_offset_sec: 0,
                  duration_sec: null,
                  from_fallback: true,
                };
                songRef.current = fallbackSong;
                setSong(fallbackSong);
                setLyrics(fbData);
                setState("playing");
                return;
              }
            }
          } catch {
            // fall through — try again on the next clip
          }
          setFallbackActive(false);
          missCountRef.current = 0;
        }
      }
      // 5xx and other statuses fall through silently to the next attempt.

      if (attemptCountRef.current >= HARD_GIVE_UP_AFTER) {
        runningRef.current = false;
        stopMic();
        setHardError("We couldn't recognize the song. Try moving closer to the speaker.");
        setState("idle");
        return;
      }

      await sleep(GAP_MS);
    }
  }, [recordClip, stopMic, handleMatch]);

  const handleListenTap = useCallback(() => {
    if (state === "listening") {
      handleStop();
    } else {
      runListenLoop();
    }
  }, [state, runListenLoop, handleStop]);

  const handleBack = useCallback(() => {
    setSong(null);
    setLyrics(null);
    runningRef.current = false;
    runListenLoop();
  }, [runListenLoop]);

  useEffect(() => () => stopMic(), [stopMic]);

  // Dev-only demo mode: `?demo` jumps straight to the now-playing view with
  // canned data so the screen can be styled / screenshotted without a live
  // ACR match. Stripped from production builds by the DEV guard + dynamic
  // import.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!new URLSearchParams(window.location.search).has("demo")) return;
    let cancelled = false;
    import("./utils/demoData.js").then(({ makeDemo }) => {
      if (cancelled) return;
      const demo = makeDemo();
      songRef.current = demo.song;
      seedClock(demo.song.play_offset_sec);
      setSong(demo.song);
      setLyrics(demo.lyrics);
      setState("playing");
    });
    return () => {
      cancelled = true;
    };
  }, [seedClock]);

  // ────────────────────────────────────────────────────────────────────
  // Continuous re-identification — see top-of-file comment.
  // ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state !== "playing") return undefined;
    if (songRef.current?.from_fallback) return undefined;

    reidActiveRef.current = true;

    const tick = async () => {
      if (!reidActiveRef.current) return;

      let clip;
      let recordEndMs;
      try {
        clip = await recordClip(CLIP_SECONDS);
        recordEndMs = performance.now();
      } catch {
        return;
      }
      if (!reidActiveRef.current || !clip) return;

      let resp;
      try {
        resp = await fetch(`${API_BASE}/identify`, {
          method: "POST",
          body: formDataWith("file", clip, "clip.wav"),
        });
      } catch {
        if (reidActiveRef.current) {
          reidTimerRef.current = setTimeout(tick, REID_INTERVAL_MS);
        }
        return;
      }

      if (!reidActiveRef.current) return;

      if (resp.ok) {
        const matched = await resp.json();
        const score = Number(matched.score) || 0;

        if (isSameSong(songRef.current, matched)) {
          const correctionSec = (performance.now() - recordEndMs) / 1000;
          const correctedOffset =
            (matched.play_offset_sec || 0) + correctionSec;
          const expected = expectedPositionSec();
          const delta = correctedOffset - expected;

          if (Math.abs(delta) <= REID_ACCEPT_TOLERANCE_SEC) {
            setSong((prev) => {
              if (!prev) return prev;
              const next = { ...prev, play_offset_sec: correctedOffset };
              songRef.current = next;
              return next;
            });
            seedClock(correctedOffset);
          }
          // else: jump too large — almost always chorus confusion. Ignore.
        } else if (score >= REID_SWITCH_MIN_SCORE) {
          // Different song with strong confidence → load it.
          await handleMatch(matched, recordEndMs);
        }
        // else: weak match for a different song — ignore (likely noise).
      }
      // A 404 (or anything else) is left to fall through and just schedule
      // the next tick. ACR routinely returns no-match during instrumental
      // bridges, quiet passages, applause, etc. — none of which mean the
      // song has ended. The lyric clock keeps ticking; only the explicit
      // Back button takes the user out of the playing view.

      if (reidActiveRef.current) {
        reidTimerRef.current = setTimeout(tick, REID_INTERVAL_MS);
      }
    };

    reidTimerRef.current = setTimeout(tick, REID_INTERVAL_MS);

    return () => {
      reidActiveRef.current = false;
      if (reidTimerRef.current) {
        clearTimeout(reidTimerRef.current);
        reidTimerRef.current = null;
      }
    };
  }, [state, recordClip, handleMatch, seedClock, expectedPositionSec]);

  // ────────────────────────────────────────────────────────────────────
  // Now-playing screen
  // ────────────────────────────────────────────────────────────────────
  if (state === "playing" && song) {
    return <NowPlayingView song={song} lyrics={lyrics} onBack={handleBack} />;
  }

  // ────────────────────────────────────────────────────────────────────
  // Landing screen — minimal, button-forward. The small top-left "Octave"
  // chip is the only branding.
  // ────────────────────────────────────────────────────────────────────
  return (
    <div
      className="relative min-h-dvh flex flex-col items-center px-6 overflow-hidden"
      style={{ minHeight: "100dvh" }}
    >
      <div className="aurora-bg" />
      <div className="grain" />
      <div className="vignette" />

      <div
        className="w-full flex items-start justify-between animate-fade-up"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <div>
          <div className="text-[10px] uppercase tracking-widest2 text-bone/60 font-medium">
            Octave
          </div>
          <div className="mt-1 text-[10px] text-bone/35 tracking-wide">
            Know every word, live.
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest2 text-bone/30">
          Live
        </div>
      </div>

      <div className="flex-1 w-full flex items-center justify-center animate-fade-up" style={{ animationDelay: "80ms" }}>
        <ListenButton
          active={state === "listening"}
          analyser={analyser}
          onClick={handleListenTap}
          sensitivity={2.5}
          size={vizSize}
          buttonSize={btnSize}
        />
      </div>

      <div className="h-7 mb-3 text-[13px] tracking-wide text-center max-w-xs">
        {micError && <span className="text-ember">{micError}</span>}
        {!micError && hardError && <span className="text-ember/90">{hardError}</span>}
        {!micError && !hardError && tooNoisy && (
          <span className="text-bone/70">Too noisy to identify…</span>
        )}
        {!micError && !hardError && !tooNoisy && state === "listening" && (
          <span className="text-bone/75 inline-flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
            {fallbackActive
              ? "Listening closely for the words…"
              : attempts >= 5
              ? "Still listening — try moving closer"
              : "Listening…"}
          </span>
        )}
        {!micError && !hardError && !tooNoisy && state === "idle" && (
          <span className="text-bone/40">Tap to start</span>
        )}
      </div>

      <p
        className="text-[11px] tracking-wide text-bone/35 text-center max-w-xs"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        Hold your phone near the source. We listen in 7-second bursts.
      </p>
    </div>
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formDataWith(name, value, filename) {
  const fd = new FormData();
  fd.set(name, value, filename);
  return fd;
}

function lyricsForm(matched) {
  const fd = new FormData();
  fd.set("title", matched.title || "");
  fd.set("artist", matched.artist || "");
  fd.set("album", matched.album || "");
  if (matched.duration_sec) fd.set("duration", String(matched.duration_sec));
  return fd;
}

function isSameSong(a, b) {
  if (!a || !b) return false;
  if (a.spotify_track_id && b.spotify_track_id) {
    return a.spotify_track_id === b.spotify_track_id;
  }
  return (
    (a.title || "").toLowerCase() === (b.title || "").toLowerCase() &&
    (a.artist || "").toLowerCase() === (b.artist || "").toLowerCase()
  );
}

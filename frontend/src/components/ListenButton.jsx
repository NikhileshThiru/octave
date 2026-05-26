// ListenButton.jsx
// Drop-in React component: a dark-themed circular "Listen" button with a
// reactive radial-bar visualization driven by an external AnalyserNode.
//
// You own the mic / AudioContext / AnalyserNode. This component is purely
// presentational: it renders the button + canvas and reads the analyser.
//
// Props:
//   active     boolean         — drives the active visuals (glow, label, color shift)
//   analyser   AnalyserNode|null — WebAudio analyser; when null, the viz idles
//   onClick    () => void      — fired on button click / Space key (if `hotkey`)
//   size       number          — overall ring size in px (default 520)
//   buttonSize number          — inner button diameter in px (default 188)
//   accent     string          — CSS color for the bars + active state (default "#a07bff")
//   sensitivity number         — gain on input level (default 1.3)
//   label      string          — idle label text (default "Listen")
//   activeLabel string         — active label text (default "Listening")
//   hotkey     boolean         — bind Space to onClick (default false)
//   className  string          — applied to the outer wrapper
//   style      object          — inline style on the outer wrapper

import React, { useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const m = String(hex).replace("#", "").match(/.{2}/g);
  if (!m) return [160, 123, 255];
  return m.map((v) => parseInt(v, 16));
}

// ─── Visualizer (canvas) ─────────────────────────────────────────────────────
function Visualizer({ active, analyser, accent, sensitivity }) {
  const canvasRef = useRef(null);

  // refs for live params so the RAF loop mounts ONCE
  const activeRef = useRef(active);
  const accentRef = useRef(accent);
  const sensRef = useRef(sensitivity);
  const analyserRef = useRef(analyser);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { accentRef.current = accent; }, [accent]);
  useEffect(() => { sensRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { analyserRef.current = analyser; }, [analyser]);

  // scratch buffers — resized whenever the analyser changes
  const freqBufRef = useRef(null);
  const timeBufRef = useRef(null);
  useEffect(() => {
    if (analyser) {
      freqBufRef.current = new Uint8Array(analyser.frequencyBinCount);
      timeBufRef.current = new Uint8Array(analyser.fftSize);
    } else {
      freqBufRef.current = null;
      timeBufRef.current = null;
    }
  }, [analyser]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let rafId = 0;
    let lastLevel = 0;
    const t0 = performance.now();

    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function render() {
      const active = activeRef.current;
      const accent = accentRef.current;
      const sensitivity = sensRef.current;
      const analyser = analyserRef.current;

      const accentRgb = hexToRgb(accent);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const baseR = Math.min(w, h) * 0.185;

      const now = performance.now();
      const dt = (now - t0) / 1000;

      // pull data if active + analyser available
      let freq = null;
      if (active && analyser && freqBufRef.current) {
        analyser.getByteFrequencyData(freqBufRef.current);
        freq = freqBufRef.current;
      }

      // overall level
      let level = 0;
      if (freq) {
        let s = 0;
        const NN = Math.floor(freq.length * 0.55);
        for (let i = 0; i < NN; i++) s += freq[i];
        level = (s / NN) / 255;
        level = Math.min(1, level * sensitivity * 1.6);
      } else {
        level = 0.05 + Math.abs(Math.sin(dt * 0.9)) * 0.03;
      }
      lastLevel = lastLevel + (level - lastLevel) * 0.18;

      // ── radial bars ────────────────────────────────────────────────
      ctx.save();
      ctx.translate(cx, cy);

      const N = 84;
      const inner = baseR + baseR * 0.14;
      const maxLen = baseR * 1.05;
      const minLen = baseR * 0.07;
      const usable = freq ? Math.floor(freq.length * 0.22) : 0;

      for (let i = 0; i < N; i++) {
        // four-way symmetry: top & bottom bass, sides mids
        const halfPos = (i % (N / 2)) / (N / 2);
        const tri = halfPos < 0.5 ? halfPos * 2 : (1 - halfPos) * 2;

        let v;
        if (freq) {
          const idx = Math.min(usable - 1, Math.floor(Math.pow(tri, 0.85) * usable));
          const specV = Math.pow(freq[idx] / 255, 0.7);
          // mix spectral + overall amplitude so EVERY bar reacts to loudness
          v = (specV * 0.85 + lastLevel * 0.65) * sensitivity;
        } else {
          v = 0.025 + 0.010 * Math.sin(dt * 0.7 + i * 0.21);
        }
        v = Math.max(0, Math.min(1.15, v));

        const a = (i / N) * Math.PI * 2 - Math.PI / 2;
        const len = minLen + v * maxLen;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const x1 = cos * inner;
        const y1 = sin * inner;
        const x2 = cos * (inner + len);
        const y2 = sin * (inner + len);

        const baseAlpha = freq ? (0.55 + v * 0.4) : 0.5;
        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0,   `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},${baseAlpha})`);
        grad.addColorStop(0.7, `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},${baseAlpha * 0.35})`);
        grad.addColorStop(1,   `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6 * dpr;
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // inner pip
        const pipR = baseR + baseR * 0.06;
        ctx.fillStyle = `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},${0.35 + v * 0.5})`;
        ctx.beginPath();
        ctx.arc(cos * pipR, sin * pipR, 0.8 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }

      // soft central glow when active
      if (active) {
        const g = ctx.createRadialGradient(0, 0, baseR * 0.5, 0, 0, baseR * 1.3);
        g.addColorStop(0, `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},0)`);
        g.addColorStop(0.55, `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},0)`);
        g.addColorStop(0.9, `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},${0.06 + lastLevel * 0.25})`);
        g.addColorStop(1, `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, baseR * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    }
    rafId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []); // mount once

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

// ─── Glyphs ──────────────────────────────────────────────────────────────────
function MicGlyph({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}
function StopGlyph({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export function ListenButton({
  active = false,
  analyser = null,
  onClick,
  size = 520,
  buttonSize = 188,
  accent = "#a07bff",
  sensitivity = 1.3,
  label = "Listen",
  activeLabel = "Listening",
  hotkey = false,
  className,
  style,
}) {
  // optional Space hotkey
  useEffect(() => {
    if (!hotkey || !onClick) return;
    const h = (e) => {
      if (e.code !== "Space") return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
      onClick();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hotkey, onClick]);

  const rgb = hexToRgb(accent);
  const accentSoft = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.18)`;
  const accentGlow = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.45)`;

  const wrapStyle = {
    position: "relative",
    width: size,
    height: size,
    display: "grid",
    placeItems: "center",
    ...style,
  };

  const breathStyle = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: buttonSize,
    height: buttonSize,
    marginLeft: -buttonSize / 2,
    marginTop: -buttonSize / 2,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.06)",
    pointerEvents: "none",
    transformOrigin: "center",
    animation: active ? "none" : "lb-breath 3.6s ease-in-out infinite",
    opacity: active ? 0 : undefined,
  };

  const btnStyle = {
    position: "relative",
    width: buttonSize,
    height: buttonSize,
    borderRadius: "50%",
    border: `1px solid ${active ? accentSoft : "rgba(255,255,255,0.06)"}`,
    background: "radial-gradient(circle at 50% 38%, #1c1c24 0%, #111118 55%, #0a0a10 100%)",
    boxShadow: active
      ? `inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -20px 60px rgba(0,0,0,0.6), 0 0 0 1px ${accentSoft}, 0 0 40px ${accentGlow}, 0 30px 100px rgba(0,0,0,0.7)`
      : "inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -20px 60px rgba(0,0,0,0.6), 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.5)",
    color: active ? accent : "#f5f5f7",
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    transition: "transform 180ms cubic-bezier(.2,.7,.2,1), box-shadow 220ms ease, color 220ms ease, border-color 220ms ease",
    outline: "none",
    overflow: "hidden",
    fontFamily: "inherit",
    zIndex: 2,
  };

  return (
    <>
      {/* one-time keyframes for the idle breath ring */}
      <style>{`
        @keyframes lb-breath {
          0%   { transform: scale(1);    opacity: 0; border-color: rgba(255,255,255,0.07); }
          20%  { opacity: 0.6; }
          100% { transform: scale(1.55); opacity: 0; border-color: rgba(255,255,255,0); }
        }
      `}</style>

      <div className={className} style={wrapStyle}>
        {!active && (
          <>
            <span style={{ ...breathStyle, animationDelay: "0s" }} />
            <span style={{ ...breathStyle, animationDelay: "-1.2s" }} />
            <span style={{ ...breathStyle, animationDelay: "-2.4s" }} />
          </>
        )}

        <Visualizer
          active={active}
          analyser={analyser}
          accent={accent}
          sensitivity={sensitivity}
        />

        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={active ? activeLabel : label}
          style={btnStyle}
        >
          <span style={{
            position: "relative", zIndex: 2,
            display: "flex", flexDirection: "column",
            alignItems: "center", gap: 10,
          }}>
            <span style={{ display: "grid", placeItems: "center" }}>
              {active ? <StopGlyph /> : <MicGlyph />}
            </span>
            <span style={{
              fontSize: 11,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: active ? accent : "#b6b6c0",
            }}>
              {active ? activeLabel : label}
            </span>
          </span>
        </button>
      </div>
    </>
  );
}

export default ListenButton;

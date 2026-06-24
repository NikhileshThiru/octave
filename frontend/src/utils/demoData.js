/**
 * Canned song + lyrics for `?demo` mode (dev only — see the dynamic import
 * in App.jsx). Lets the now-playing view be styled, tested, and screenshotted
 * without a mic, a backend, or a live ACR match.
 *
 * The cover is painted on a canvas at runtime: a same-origin data URL never
 * taints the palette extractor, and it gives the adaptive theming real color
 * to work with. Lyrics are original placeholder text, not a real song.
 */

const LINE_TEXTS = [
  "City lights are humming down the boulevard",
  "Every window's golden in the dark",
  "We were only strangers for a minute there",
  "Now the night is ours to fall apart",
  "Hold the moment steady while it's burning slow",
  "Nobody has to say where this goes",
  "I can hear the music through the thinning crowd",
  "Every chorus louder than before",
  "If the morning never finds us dancing here",
  "We'll be in the echo evermore",
  "Caught in the afterglow",
  "Where the slow song goes",
  "Everything we don't say",
  "Says it more",
  "Speakers in the stairwell shaking dust awake",
  "Someone's singing every second line",
  "You know all the words before they happen now",
  "Like the song was yours before it was mine",
  "Hold the moment steady while it's burning slow",
  "Nobody has to say where this goes",
  "Caught in the afterglow",
  "Where the slow song goes",
  "Everything we don't say",
  "Says it more",
  "And if the lights come up too soon",
  "We'll hum it on the way back home",
  "Caught in the afterglow",
  "Evermore",
];

export function makeDemo() {
  const lines = LINE_TEXTS.map((text, i) => ({
    // ~4.6 s per line starting at 0:12 — enough spread for the scroll to read
    time: 12 + i * 4.6,
    text,
  }));

  const song = {
    title: "Afterglow",
    artist: "Velvet Antenna",
    album: "Night Static",
    album_art_url: paintDemoCover(),
    spotify_track_id: null,
    play_offset_sec: 38,
    duration_sec: 184,
    // Suppresses the re-identification loop (which would grab the mic) —
    // demo mode has no real audio to re-identify against.
    from_fallback: true,
  };

  const lyrics = {
    found: true,
    synced: true,
    lines,
    plain: null,
  };

  return { song, lyrics };
}

function paintDemoCover() {
  const size = 640;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Dusk gradient base
  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, "#2b1a4e");
  base.addColorStop(0.55, "#7a2e57");
  base.addColorStop(1, "#e0653a");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Soft glow blobs for palette variety
  const blob = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  };
  blob(size * 0.78, size * 0.22, size * 0.5, "rgba(255,170,80,0.55)");
  blob(size * 0.2, size * 0.8, size * 0.55, "rgba(70,40,160,0.6)");

  // Horizon line + sun disc, poster-style
  ctx.fillStyle = "rgba(255,225,170,0.9)";
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.46, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(20,10,40,0.85)";
  ctx.fillRect(0, size * 0.62, size, size * 0.38);

  ctx.fillStyle = "rgba(245,242,236,0.92)";
  ctx.font = `600 ${size * 0.055}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("VELVET ANTENNA", size * 0.5, size * 0.74);
  ctx.fillStyle = "rgba(245,242,236,0.55)";
  ctx.font = `400 ${size * 0.035}px Manrope, sans-serif`;
  ctx.fillText("NIGHT STATIC", size * 0.5, size * 0.81);

  return canvas.toDataURL("image/png");
}

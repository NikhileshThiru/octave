/**
 * Dominant-color extraction for album covers — drives the per-song aurora
 * tint on the now-playing view.
 *
 * Approach: draw the cover into a tiny offscreen canvas (32×32 is plenty —
 * we want the overall color story, not detail), bucket the chromatic pixels
 * by hue, and average the two heaviest buckets. Weights favor saturated,
 * mid-lightness pixels so a colorful logo on a black sleeve still wins over
 * the background.
 *
 * The resulting colors are re-clamped into a lightness/saturation band that
 * reads well as a glow on the near-black UI — a pastel cover and a neon
 * cover both come out as usable atmosphere, just with their own hue.
 *
 * Returns `{ primary: [r,g,b], secondary: [r,g,b] }`, or `null` when the
 * cover can't be sampled (CORS-tainted canvas, network error) or is
 * effectively monochrome. Callers must treat `null` as "keep the default
 * aurora".
 */

const SAMPLE_SIZE = 32;
const HUE_BUCKETS = 12;

export function extractPalette(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        resolve(paletteFromImage(img));
      } catch {
        // getImageData throws on a tainted canvas (CDN without CORS headers).
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function paletteFromImage(img) {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  // weight + weighted h/s/l sums per hue bucket
  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({
    weight: 0,
    h: 0,
    s: 0,
    l: 0,
  }));
  let chromaticWeight = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue; // skip transparent padding
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    // Near-black, near-white, and gray pixels carry no hue information.
    if (l < 0.08 || l > 0.95 || s < 0.12) continue;

    // Saturated, mid-lightness pixels define the cover's color identity.
    const weight = s * (1 - Math.abs(l - 0.5));
    const b = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    buckets[b].weight += weight;
    buckets[b].h += h * weight;
    buckets[b].s += s * weight;
    buckets[b].l += l * weight;
    chromaticWeight += weight;
  }

  // Monochrome cover (or close to it) — let the default aurora stand.
  if (chromaticWeight < 4) return null;

  const ranked = buckets
    .map((b, i) => ({ ...b, i }))
    .filter((b) => b.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const primary = bucketColor(ranked[0]);
  // Prefer a secondary at least 2 hue-buckets (60°) away so the two aurora
  // lobes don't collapse into one blob of the same color.
  const distinct = ranked.find(
    (b) => hueBucketDistance(b.i, ranked[0].i) >= 2 && b.weight > ranked[0].weight * 0.18
  );
  const secondary = bucketColor(distinct || ranked[1] || ranked[0], !distinct);

  return { primary, secondary };
}

function hueBucketDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, HUE_BUCKETS - d);
}

function bucketColor(bucket, shiftHue = false) {
  let h = bucket.h / bucket.weight;
  const s = bucket.s / bucket.weight;
  const l = bucket.l / bucket.weight;
  // When the cover is single-hued, nudge the secondary lobe a little around
  // the wheel so the backdrop still has gentle depth.
  if (shiftHue) h = (h + 0.07) % 1;
  return hslToRgb(
    h,
    clamp(s, 0.45, 0.85),
    clamp(l, 0.3, 0.52)
  );
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Parse a raw LRC string into a sorted list of timed lines.
 *
 * Handles:
 *   [mm:ss.xx] text        — standard format
 *   [mm:ss]    text        — no fractional seconds
 *   [mm:ss.xxx] text       — millisecond precision
 *   [00:12.00][00:45.00] chorus  — repeated timestamps on one line
 *   [ar:Artist] / [ti:Title] / etc — ignored
 *
 * Returns: Array<{ time: number, text: string }> sorted by time.
 */

const TIMESTAMP_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLRC(raw) {
  if (!raw || typeof raw !== "string") return [];

  const lines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(TIMESTAMP_RE)];
    if (matches.length === 0) continue;
    const text = rawLine.replace(TIMESTAMP_RE, "").trim();
    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      const fracStr = m[3] ?? "0";
      const frac = parseInt(fracStr, 10) / Math.pow(10, fracStr.length);
      const time = minutes * 60 + seconds + frac;
      lines.push({ time, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * Find the index of the active lyric line for a given playback time.
 * Returns -1 if `time` precedes the first line.
 */
export function activeLineIndex(lines, time) {
  if (!lines || lines.length === 0) return -1;
  // Binary search for the last line whose time <= playback time.
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

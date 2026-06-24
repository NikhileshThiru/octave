import assert from "node:assert/strict";
import { parseLRC, activeLineIndex } from "./lrcParser.js";

const SAMPLE = `[ar:Rick Astley]
[ti:Never Gonna Give You Up]
[00:00.00] (instrumental)
[00:18.45] We're no strangers to love
[00:22.10] You know the rules and so do I
[00:26.85] A full commitment's what I'm thinking of
[01:00.50][02:15.50] Never gonna give you up
[01:03.20][02:18.20] Never gonna let you down
`;

const parsed = parseLRC(SAMPLE);
const expected = [
  { time: 0, text: "(instrumental)" },
  { time: 18.45, text: "We're no strangers to love" },
  { time: 22.1, text: "You know the rules and so do I" },
  { time: 26.85, text: "A full commitment's what I'm thinking of" },
  { time: 60.5, text: "Never gonna give you up" },
  { time: 63.2, text: "Never gonna let you down" },
  { time: 135.5, text: "Never gonna give you up" },
  { time: 138.2, text: "Never gonna let you down" },
];

assert.deepEqual(parsed, expected);
assert.equal(activeLineIndex(parsed, 0), 0);
assert.equal(activeLineIndex(parsed, 22.5), 2);
assert.equal(activeLineIndex(parsed, 200), 7);
assert.equal(activeLineIndex(parsed, -5), -1);

console.log("OK");

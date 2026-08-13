// Diagnostic helper: decompress a session.jsonl.zstd log and inspect events.
// Usage: node scripts/inspect-session.mjs <path-to-session.jsonl.zstd> [seq]
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const [, , file, targetSeq] = process.argv;
if (!file) {
  console.error("usage: node inspect-session.mjs <session.jsonl.zstd> [seq]");
  process.exit(2);
}

const raw = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let cursor = 0;
const chunks = [];
let frames = 0;
// Concatenated frames: walk frame by frame using the zstd frame header magic.
while (cursor < raw.length) {
  if (!raw.subarray(cursor, cursor + 4).equals(MAGIC)) {
    console.error(`non-frame bytes at offset ${cursor} (${raw.length - cursor} trailing)`);
    break;
  }
  // Find the end of this frame: magic of next frame or EOF.
  let next = raw.indexOf(MAGIC, cursor + 4);
  if (next === -1) next = raw.length;
  try {
    chunks.push(zstdDecompressSync(raw.subarray(cursor, next)));
    frames++;
  } catch (err) {
    console.error(`frame ${frames} decode failed: ${err.message}`);
    break;
  }
  cursor = next;
}
console.log(`decoded ${frames} frame(s), total plaintext ${chunks.reduce((n, c) => n + c.length, 0)} bytes`);

const text = Buffer.concat(chunks).toString("utf8");
const lines = text.split("\n").filter((l) => l.trim().length > 0);
console.log(`total lines: ${lines.length}`);
if (lines.length === 0) process.exit(0);

// Find the header line (first) and index of events.
const events = lines.map((l, i) => ({ line: l, idx: i }));
const header = events[0];

if (!targetSeq) {
  console.log(`first line (header): ${header.line.slice(0, 400)}`);
  console.log(`last line: ${lines[lines.length - 1].slice(0, 400)}`);
  // Print seq distribution around the tail to find corruption.
  const parsed = [];
  for (const { line, idx } of events.slice(1)) {
    try {
      const ev = JSON.parse(line);
      parsed.push({ idx, seq: ev.seq, type: ev.type });
    } catch {
      parsed.push({ idx, seq: "PARSE-FAIL", type: line.slice(0, 80) });
    }
  }
  const tail = parsed.slice(-30);
  for (const p of tail) console.log(`line ${p.idx}: seq=${p.seq} ${p.type}`);
  process.exit(0);
}

// Print the event with the given seq and its neighbors.
let found = 0;
for (const { line, idx } of events.slice(1)) {
  try {
    const ev = JSON.parse(line);
    if (ev.seq === Number(targetSeq)) {
      console.log(`=== line ${idx}: seq ${ev.seq} type ${ev.type} ===`);
      console.log(JSON.stringify(ev, null, 2));
      found++;
    } else if (found > 0 && ev.seq > Number(targetSeq) + 2) {
      break;
    }
  } catch (err) {
    if (found > 0) {
      console.log(`--- unparseable line ${idx}: ${line.slice(0, 200)}`);
    }
  }
}
if (!found) console.log(`no event with seq ${targetSeq} found`);

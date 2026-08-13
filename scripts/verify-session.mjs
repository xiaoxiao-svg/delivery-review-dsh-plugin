// Verify a session.jsonl.zstd log against the invariants DSH's JSONL backend
// actually enforces:
//   1. every complete zstd frame independently decodes,
//   2. the FIRST frame is exactly one header line (byte search for \n),
//   3. every line parses as JSON,
//   4. message events pass the same shape checks as dsh-session's
//      assertMessageEventShape (id / role / source / content array /
//      tool-result block shape).
// Usage: node scripts/verify-session.mjs <path-to-session.jsonl.zstd>
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { scanZstdFrames, assertHeaderFrame } from "./zstd-frames.mjs";

const [, , file] = process.argv;
if (!file) {
  console.error("usage: node verify-session.mjs <session.jsonl.zstd>");
  process.exit(2);
}

const raw = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(raw);
console.log(`${frames.length} complete frame(s)${tornStart !== undefined ? ` + torn tail at byte ${tornStart}` : ""}`);

// Invariant 2: first frame = exactly one header line (Buffer byte search).
try {
  assertHeaderFrame(zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end)));
  console.log("first frame: exactly one header line OK");
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  process.exit(1);
}

// Invariants 3 + 4: per-frame line parsing and message shape.
let errors = 0;
let lines = 0;
let checked = 0;
frames.forEach(({ start, end }, fi) => {
  const plain = zstdDecompressSync(raw.subarray(start, end)).toString("utf8");
  plain.split("\n").forEach((line, li) => {
    if (line.trim() === "") return;
    lines++;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      console.log(`FAIL: frame ${fi} line ${li} does not parse: ${e.message}`);
      errors++;
      return;
    }
    const type = ev.type;
    if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") return;
    checked++;
    const data = ev.data;
    const record = data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
    const message = type === "user/message" ? record : record?.message;
    if (!message || typeof message !== "object" || typeof message.id !== "string" || message.id === "") {
      console.log(`FAIL: seq ${ev.seq} (${type}): lacks identified message`); errors++;
    } else {
      const expectedRole = type === "assistant/message" ? "assistant" : "user";
      if (message.role !== expectedRole) { console.log(`FAIL: seq ${ev.seq}: role must be "${expectedRole}"`); errors++; }
      const source = message.source;
      if (!source || typeof source !== "object" || typeof source.kind !== "string" || source.kind === "") {
        console.log(`FAIL: seq ${ev.seq}: invalid source`); errors++;
      }
      if (!Array.isArray(message.content)) {
        console.log(`FAIL: seq ${ev.seq}: message has invalid content (${typeof message.content})`); errors++;
      } else if (type === "tool/result") {
        const block = message.content[0];
        if (message.content.length !== 1 || !block || block.type !== "tool-result" || !Array.isArray(block.content)) {
          console.log(`FAIL: seq ${ev.seq}: tool/result must contain one tool-result block`); errors++;
        }
      }
    }
  });
});
console.log(`${lines} line(s), ${checked} message event(s) checked, ${errors} error(s)`);
process.exit(errors === 0 ? 0 : 1);

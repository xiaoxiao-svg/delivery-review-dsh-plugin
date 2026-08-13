// Repair helper (frame-preserving): rewrite a session.jsonl.zstd log, wrapping
// any message whose `content` is a bare string into [{ type: "text", text }].
//
// CRITICAL: DSH's JSONL backend treats the log as a sequence of independently
// decodable zstd frames — the FIRST frame must be exactly one header line, and
// later frames carry event batches. A single-frame rewrite of the whole log
// makes DSH reject it at startup ("corrupt Zstandard session log: first frame
// is not exactly one header line"). This script therefore decodes and rewrites
// frame by frame, preserving the original frame boundaries (a torn final tail
// is passed through untouched).
//
// Usage: node scripts/repair-session.mjs <path-to-session.jsonl.zstd>
// The original file is kept as <path>.bak.zstd next to it.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";
import { scanZstdFrames, assertHeaderFrame } from "./zstd-frames.mjs";

const [, , file] = process.argv;
if (!file) {
  console.error("usage: node repair-session.mjs <session.jsonl.zstd>");
  process.exit(2);
}

const raw = readFileSync(file);
const { frames, tornStart } = scanZstdFrames(raw);
console.log(`split into ${frames.length} complete frame(s)${tornStart !== undefined ? ` + torn tail at byte ${tornStart}` : ""}`);

// Assert the DSH header-frame invariant before touching anything.
assertHeaderFrame(zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end)));

let fixed = 0;
const rebuilt = [];
for (const { start, end } of frames) {
  const plain = zstdDecompressSync(raw.subarray(start, end));
  const lines = plain.toString("utf8").split("\n");
  const out = lines.map((line) => {
    if (line.trim() === "") return line;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return line; // leave unparseable lines alone
    }
    const patch = (msg) => {
      if (msg && typeof msg === "object" && !Array.isArray(msg.content) && typeof msg.content === "string") {
        msg.content = [{ type: "text", text: msg.content }];
        fixed++;
      }
    };
    if (ev.type === "user/message") patch(ev.data);
    else if (ev.type === "assistant/message" || ev.type === "tool/result") patch(ev.data?.message);
    return ev === undefined ? line : JSON.stringify(ev);
  });
  rebuilt.push(zstdCompressSync(out.join("\n")));
}
// Preserve a torn tail byte-for-byte (the backend repairs it on load itself).
if (tornStart !== undefined) rebuilt.push(raw.subarray(tornStart));

console.log(`wrapped ${fixed} string-content message(s) into text blocks`);
if (fixed === 0) {
  console.log("nothing to fix; leaving file untouched");
  process.exit(0);
}

renameSync(file, `${file}.bak.zstd`);
writeFileSync(file, Buffer.concat(rebuilt));
console.log(`wrote repaired log (${frames.length} frame(s), boundaries preserved); backup at ${file}.bak.zstd`);

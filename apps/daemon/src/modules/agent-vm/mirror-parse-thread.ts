import { parentPort } from "node:worker_threads";
import { type Checked, entryFacts } from "./mirror-line.ts";
import { topLevelIdOf } from "./mirror-id.ts";

// The mirror's parse thread (R32): one line at a time, so a 12 MiB image line never blocks the daemon's event loop. It runs
// the same `entryFacts` as the inline check and answers the verdict, never the parsed value.
const port = parentPort;
if (!port) throw new Error("mirror-parse-thread runs as a worker thread");

port.on("message", (message: { id: number; bytes: Uint8Array; first: boolean }) => {
  let checked: Checked;
  // RT-27, AVM-E29: the byte scan of a long line runs here too, not on the daemon's event loop.
  const bytes = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength);
  const topId = topLevelIdOf(bytes);
  try {
    const text = bytes.toString("utf8");
    checked = entryFacts(JSON.parse(text), message.first);
  } catch {
    checked = { ok: false, reason: "not_json" };
  }
  port.postMessage({ id: message.id, checked, topId });
});

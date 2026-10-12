import type { Redactor } from "./policy/redact.ts";

type Write = (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => boolean;
export interface Writable {
  write: Write;
}

const DROPPED_LINE = "pi-host: output could not be checked for secrets: dropped\n";

/**
 * The worker's stdout and stderr end up in the daemon's log tail: an extension or Pi that prints a secret value must not
 * reach it. Every chunk is checked against the secrets known at that moment. A secret split across two writes is not
 * found (documented residual, Task 26). A chunk that cannot be checked is replaced by a fixed line.
 */
export function redactStdio(stream: Writable, current: () => Redactor): void {
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    try {
      const redactor = current();
      const onWritten = typeof encoding === "function" ? encoding : callback;
      if (redactor.size === 0) return original(chunk, encoding, callback);
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const done = redactor.text(text);
      return done.count === 0 ? original(chunk, encoding, callback) : original(done.text, "utf8", onWritten);
    } catch {
      return original(DROPPED_LINE, "utf8", typeof encoding === "function" ? encoding : callback);
    }
  };
}

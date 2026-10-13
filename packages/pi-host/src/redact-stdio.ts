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
    // Not text and not bytes: Node's own write refuses it with its own error.
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
      return original(chunk, encoding, callback);
    const onWritten = typeof encoding === "function" ? encoding : callback;
    try {
      const redactor = current();
      if (redactor.size === 0) return original(chunk, encoding, callback);
      // base64 and hex strings are decoded first, or their secret would never match, and the redacted text goes out as
      // utf8. Any other encoding names how the characters become bytes: they are checked as they are and written back
      // with their own encoding.
      const decoded =
        typeof chunk === "string" &&
        (encoding === "base64" || encoding === "base64url" || encoding === "hex");
      const text = decoded
        ? Buffer.from(chunk, encoding).toString("utf8")
        : typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");
      const done = redactor.text(text);
      if (done.count === 0) return original(chunk, encoding, callback);
      return decoded || typeof chunk !== "string"
        ? original(done.text, "utf8", onWritten)
        : original(done.text, encoding, callback);
    } catch {
      return original(DROPPED_LINE, "utf8", onWritten);
    }
  };
}

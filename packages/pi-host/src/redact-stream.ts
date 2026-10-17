import { StringDecoder } from "node:string_decoder";
import type { Redactor } from "./policy/redact.ts";

/** Every form a value can take in the output: raw, or inside a JSON string (`redactor.text` knows both). */
const formsOf = (redactor: Redactor): string[] =>
  redactor.entries.flatMap((entry) => [entry.value, JSON.stringify(entry.value).slice(1, -1)]);

/** The length of the longest tail of `text` that is a proper prefix of a form: only that much can still become a value. */
const prefixTail = (text: string, forms: readonly string[]): number => {
  let longest = 0;
  for (const form of forms) {
    for (let k = Math.min(form.length - 1, text.length); k > longest; k--) {
      if (form.startsWith(text.slice(text.length - k))) {
        longest = k;
        break;
      }
    }
  }
  return longest;
};

/**
 * A stream of text with every known value replaced, even when a piece ends in the middle of one. Only the
 * longest tail of what was received that is a PREFIX of a known value form is held back, until more text (or the end)
 * shows whether it becomes the value, so no piece ever carries a prefix of one and plain text streams with no lag. Used for the output of a command (Pi writes what it is handed to a
 * full-output file before any result is redacted) and for the deltas of a message the model is typing (W5-R60). `count()`
 * is the number of replacements made so far.
 */
export function createStreamRedactor(current: () => Redactor) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let replaced = 0;
  const emit = (text: string): Buffer => Buffer.from(text);
  const pushText = (text: string): string => {
    const redactor = current();
    pending += text;
    if (redactor.size === 0) {
      const all = pending;
      pending = "";
      return all;
    }
    const done = redactor.text(pending);
    pending = done.text;
    replaced += done.count;
    let cut = pending.length - prefixTail(pending, formsOf(redactor));
    if (cut <= 0) return "";
    // Never between the two halves of a surrogate pair.
    const unit = pending.charCodeAt(cut - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) cut--;
    const ready = pending.slice(0, cut);
    pending = pending.slice(cut);
    return ready;
  };
  const flushText = (rest = ""): string => {
    const redactor = current();
    const all = pending + rest;
    pending = "";
    if (redactor.size === 0) return all;
    const done = redactor.text(all);
    replaced += done.count;
    return done.text;
  };
  return {
    pushText,
    flushText: () => flushText(),
    push: (chunk: Buffer): Buffer => emit(pushText(decoder.write(chunk))),
    /** The held tail, redacted, at the end of the stream. */
    flush: (): Buffer => emit(flushText(decoder.end())),
    count: (): number => replaced,
  };
}

const MAX_KEPT = 256;
const counts = new Map<string, number>();

/** What a command's stream redaction replaced, by tool call: stage 06 adds it to its own count (it sees redacted text). */
export function addStreamCount(toolCallId: string, count: number): void {
  if (count <= 0) return;
  counts.set(toolCallId, (counts.get(toolCallId) ?? 0) + count);
  for (const old of counts.keys()) {
    if (counts.size <= MAX_KEPT) break;
    counts.delete(old);
  }
}

/** The count of this tool call, once: the entry is gone after. */
export function takeStreamCount(toolCallId: string): number {
  const count = counts.get(toolCallId) ?? 0;
  counts.delete(toolCallId);
  return count;
}

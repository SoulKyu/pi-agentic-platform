import { createHash } from "node:crypto";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";

/** RT-27: a line up to this size is parsed on the event loop; a longer one in the mirror's parse thread, one at a time. */
export const INLINE_PARSE_BYTES = 1024 * 1024;
export type MirrorRefusal =
  "offset" | "line_too_large" | "not_json" | "not_entry" | "no_header" | "duplicate_id" | "file" | "quota";

/**
 * What the mirror keeps of a checked line: its id (null for the header), the hash of a user message's text and, for the
 * header only, its id (the worker reports the id of the last line, the header's included, as `lastEntryId`).
 */
export interface EntryFacts {
  readonly id: string | null;
  readonly userText: string | null;
  readonly headerId: string | null;
}
export type Checked =
  { readonly ok: true; readonly facts: EntryFacts } | { readonly ok: false; readonly reason: MirrorRefusal };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const promptHash = sha256;

/** The text of a Pi user message (a string, or its text blocks joined by a new line), as pap hashes what it sends. */
export function userTextOf(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * AVM-E22: an entry id is plain ASCII. Pi writes 8 hex characters (or a UUID); anything else (a newline, a lone surrogate,
 * a control character) is not a Pi id, and could not be told apart in the unverified list or survive a round trip.
 */
export const ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The header is small; a longer first line is not one the mirror keeps. */
export const HEADER_MAX_BYTES = 64 * 1024;

const validId = (id: unknown): id is string => typeof id === "string" && ENTRY_ID.test(id);

/** Spec §11, R1, R32: a completed line is a Pi entry, or the mirror stops. `value` is the parsed line (inline or in the thread). */
export function entryFacts(value: unknown, first: boolean): Checked {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, reason: "not_entry" };
  const { type, id, message } = value as { type?: unknown; id?: unknown; message?: unknown };
  if (typeof type !== "string" || type.length === 0 || type.length > 64)
    return { ok: false, reason: "not_entry" };
  if (first) {
    if (type !== "session") return { ok: false, reason: "no_header" };
    if (id !== undefined && !validId(id)) return { ok: false, reason: "not_entry" };
    return { ok: true, facts: { id: null, userText: null, headerId: id ?? null } };
  }
  if (!validId(id)) return { ok: false, reason: "not_entry" };
  const text = type === "message" ? userTextOf(message) : null;
  return { ok: true, facts: { id, userText: text === null ? null : sha256(text), headerId: null } };
}

/** The inline path: a line up to INLINE_PARSE_BYTES. Longer lines go to the parse thread, which runs the same `entryFacts`. */
export function checkMirrorLine(line: Buffer, first: boolean): Checked {
  if (line.length > MAX_SESSION_LINE_BYTES) return { ok: false, reason: "line_too_large" };
  if (line.length > INLINE_PARSE_BYTES) throw new RangeError("parse this line in the mirror's parse thread");
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  return entryFacts(value, first);
}

/**
 * RT-26: whether a user entry is one pap sent. The VM worker handle records the hash of every prompt, steer and follow-up it
 * sends (at most 256 kept); a prompt starting with `/` (a template or skill Pi expands) allows one user entry whatever its
 * text. A user entry matching neither renders as "not sent from pap" (an extension's message, or a forged one).
 */
export function createProvenance(limit = 256) {
  const sent: string[] = [];
  let expansions = 0;
  return {
    sent(text: string): void {
      if (text.startsWith("/")) expansions = Math.min(expansions + 1, limit);
      else {
        sent.push(sha256(text));
        if (sent.length > limit) sent.shift();
      }
    },
    /** Whether `verify` would say pap sent it, consuming nothing (the live view marks a forged row before the mirror's verdict). */
    peek(userText: string): boolean {
      return sent.includes(userText) || expansions > 0;
    },
    /** True: pap sent it. Consumes the match. */
    verify(userText: string): boolean {
      const at = sent.indexOf(userText);
      if (at >= 0) {
        sent.splice(at, 1);
        return true;
      }
      if (expansions > 0) {
        expansions--;
        return true;
      }
      return false;
    },
  };
}
export type Provenance = ReturnType<typeof createProvenance>;

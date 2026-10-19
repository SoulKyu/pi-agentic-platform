import { createHash } from "node:crypto";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  checkMirrorLine,
  createProvenance,
  headIdOf,
  INLINE_PARSE_BYTES,
  promptHash,
  userTextOf,
} from "./mirror-line.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const line = (value: unknown) => Buffer.from(JSON.stringify(value));
const header = { type: "session", version: 3, id: "hdr00001" };
const message = (id: string, body: unknown) => ({ type: "message", id, message: body });

// Mutants (RT-43), each run for real:
// - M-NONOBJECT: accept a non-object (`entryFacts` without the object guard): killed by the `[1]` / `null` / `"x"` cases.
// - M-NOHEADER: skip the header check (`first` ignored): killed by "refuses a first line that is not the header" and
//   "a header line is refused after the first".
// - M-DUPLICATE (mirror.test.ts): drop the duplicate-id check: killed by "refuses a duplicate id".
// - M-HEADID (mirror.test.ts): drop the head/parsed id comparison: killed by "refuses a line whose first id differs".
describe("checkMirrorLine (R1, R32)", () => {
  it("accepts the header first and refuses it later", () => {
    expect(checkMirrorLine(line(header), true)).toEqual({
      ok: true,
      facts: { id: null, userText: null, headerId: "hdr00001" },
    });
    expect(checkMirrorLine(line(header), false)).toEqual({
      ok: true,
      facts: { id: "hdr00001", userText: null, headerId: null },
    });
  });

  it("refuses a first line that is not the header", () => {
    expect(checkMirrorLine(line(message("a1", {})), true)).toEqual({ ok: false, reason: "no_header" });
  });

  it("refuses what is not JSON", () => {
    expect(checkMirrorLine(Buffer.from("{nope"), false)).toEqual({ ok: false, reason: "not_json" });
    expect(checkMirrorLine(Buffer.from(""), false)).toEqual({ ok: false, reason: "not_json" });
  });

  it.each([
    ["an array", [1]],
    ["null", null],
    ["a string", "x"],
    ["a number", 7],
    ["no id", { type: "message" }],
    ["a numeric id", { type: "message", id: 4 }],
    ["an empty id", { type: "message", id: "" }],
    ["a 65 character type", { type: "t".repeat(65), id: "a1" }],
    ["an empty type", { type: "", id: "a1" }],
    ["a 129 character id", { type: "message", id: "i".repeat(129) }],
  ])("refuses %s as not_entry", (_name, value) => {
    expect(checkMirrorLine(line(value), false)).toEqual({ ok: false, reason: "not_entry" });
  });

  // Mutant M-CHARSET: accept any string id again: killed here (AVM-E22).
  it.each([
    ["a newline", "a\nb"],
    ["a lone surrogate", "a\ud800"],
    ["a space", "a b"],
    ["a control character", "a\u0001"],
    ["a slash", "a/b"],
    ["a non-ASCII letter", "\u00e9"],
  ])("refuses an id with %s as not_entry, and a header with one", (_name, id) => {
    expect(checkMirrorLine(Buffer.from(JSON.stringify({ type: "message", id })), false)).toEqual({
      ok: false,
      reason: "not_entry",
    });
    expect(checkMirrorLine(Buffer.from(JSON.stringify({ type: "session", id })), true)).toEqual({
      ok: false,
      reason: "not_entry",
    });
  });

  it("takes Pi's ids: 8 hex characters and a UUID", () => {
    for (const id of ["a1b2c3d4", "0f6c0f2e-1111-4222-8333-444455556666"])
      expect(checkMirrorLine(line({ type: "message", id }), false)).toMatchObject({ ok: true });
  });

  it("takes a 64 character type and a 128 character id", () => {
    expect(checkMirrorLine(line({ type: "t".repeat(64), id: "i".repeat(128) }), false)).toMatchObject({
      ok: true,
    });
  });

  it("hashes the text of a user message: a string, or text blocks joined by new lines around an image", () => {
    expect(checkMirrorLine(line(message("u1", { role: "user", content: "hello" })), false)).toEqual({
      ok: true,
      facts: { id: "u1", userText: sha("hello"), headerId: null },
    });
    const blocks = [
      { type: "text", text: "one" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "two" },
    ];
    expect(checkMirrorLine(line(message("u2", { role: "user", content: blocks })), false)).toMatchObject({
      facts: { userText: sha("one\ntwo") },
    });
    expect(userTextOf({ role: "user", content: 5 })).toBeNull();
    expect(promptHash("x")).toBe(sha("x"));
  });

  it("gives no hash for an assistant message or another entry type", () => {
    expect(checkMirrorLine(line(message("a1", { role: "assistant", content: "x" })), false)).toMatchObject({
      facts: { id: "a1", userText: null },
    });
    expect(
      checkMirrorLine(line({ type: "custom", id: "c1", message: { role: "user", content: "x" } }), false),
    ).toMatchObject({ facts: { userText: null } });
  });

  it("sends a line over 1 MiB to the parse thread (RangeError) and refuses one over 32 MiB", () => {
    expect(() => checkMirrorLine(Buffer.alloc(INLINE_PARSE_BYTES + 1, 0x20), false)).toThrow(RangeError);
    expect(() => checkMirrorLine(Buffer.alloc(INLINE_PARSE_BYTES, 0x20), false)).not.toThrow(RangeError);
    expect(checkMirrorLine(Buffer.alloc(MAX_SESSION_LINE_BYTES + 1), false)).toEqual({
      ok: false,
      reason: "line_too_large",
    });
  });
});

describe("headIdOf", () => {
  it("reads the id where Pi writes it, right after the type", () => {
    expect(headIdOf(Buffer.from('{"type":"message","id":"a1b2","parentId":null}'))).toBe("a1b2");
  });
  it("is null when the id is not in the first 512 bytes, or not right after the type", () => {
    expect(headIdOf(Buffer.from(`{"type":"message","pad":"${"x".repeat(600)}","id":"a1"}`))).toBeNull();
    expect(headIdOf(Buffer.from('{"id":"a1","type":"message"}'))).toBeNull();
    expect(headIdOf(Buffer.from('{"type":"session","version":3,"id":"h"}'))).toBeNull();
  });
});

// Mutant M-PROVWINDOW: keep every sent text (no 256 window): killed by "keeps only the last 256 sent texts".
// Mutant M-PROVCONSUME: `verify` does not consume a match: killed by "a sent text verifies once".
describe("createProvenance (RT-26, R32)", () => {
  it("a sent text verifies once", () => {
    const provenance = createProvenance();
    provenance.sent("hello");
    expect(provenance.verify(sha("hello"))).toBe(true);
    expect(provenance.verify(sha("hello"))).toBe(false);
  });

  it("an unsent text does not verify", () => {
    const provenance = createProvenance();
    provenance.sent("hello");
    expect(provenance.verify(sha("forged"))).toBe(false);
  });

  it("a `/` prompt allows one entry whatever its text, and is not itself a sent text", () => {
    const provenance = createProvenance();
    provenance.sent("/review the diff");
    expect(provenance.verify(sha("/review the diff"))).toBe(true);
    expect(provenance.verify(sha("anything else"))).toBe(false);
    provenance.sent("/a");
    expect(provenance.verify(sha("expanded template text"))).toBe(true);
    expect(provenance.verify(sha("expanded template text"))).toBe(false);
  });

  it("keeps only the last 256 sent texts", () => {
    const provenance = createProvenance();
    for (let i = 0; i < 257; i++) provenance.sent(`text ${i}`);
    expect(provenance.verify(sha("text 0"))).toBe(false);
    expect(provenance.verify(sha("text 1"))).toBe(true);
    expect(provenance.verify(sha("text 256"))).toBe(true);
  });
});

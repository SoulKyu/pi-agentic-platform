import { readFileSync, statSync, writeFileSync } from "node:fs";
import { MAX_SESSION_LINE_BYTES } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT, appendOf, entry, HEADER, imageEntry } from "./mirror-fixtures.ts";
import { bed, cleanup, clock, fileText, fresh, log, MiB, open, parsed, refusals } from "./mirror-harness.ts";
import { checkMirrorLine } from "./mirror-line.ts";
import { createLineParser } from "./mirror-parse.ts";

afterEach(cleanup);

describe("appends (R1)", () => {
  it("starts empty, appends complete lines at its next byte and answers its facts", () => {
    fresh();
    const mirror = open();
    expect(mirror.path).toBe(bed.path);
    expect(mirror.facts()).toEqual({ size: 0, lastEntryId: null });
    expect(mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")))).toBe("ok");
    expect(mirror.facts()).toEqual({ size: HEADER.length + entry("e1").length, lastEntryId: "e1" });
    expect(mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e2")))).toBe("ok");
    expect(fileText()).toBe(HEADER + entry("e1") + entry("e2"));
    expect(mirror.facts().lastEntryId).toBe("e2");
  });

  it("keeps the partial last line in memory and writes only what is complete", () => {
    fresh();
    const mirror = open();
    const second = entry("e1");
    const cut = 20;
    expect(mirror.onSessionAppend(appendOf(0, HEADER + second.slice(0, cut)))).toBe("ok");
    expect(fileText()).toBe(HEADER);
    expect(mirror.facts().size).toBe(HEADER.length);
    // The worker's next chunk starts after the partial bytes it already sent.
    expect(mirror.onSessionAppend(appendOf(HEADER.length + cut, second.slice(cut)))).toBe("ok");
    expect(fileText()).toBe(HEADER + second);
    expect(mirror.facts().lastEntryId).toBe("e1");
  });

  it("puts a line back together from three chunks and splits two lines in one chunk", () => {
    fresh();
    const mirror = open();
    const text = HEADER + entry("e1") + entry("e2");
    const third = Math.ceil(text.length / 3);
    for (let at = 0; at < text.length; at += third) {
      expect(mirror.onSessionAppend(appendOf(at, text.slice(at, at + third)))).toBe("ok");
    }
    expect(fileText()).toBe(text);
    expect(mirror.facts().lastEntryId).toBe("e2");
  });

  it("accepts an empty chunk (a replace of an empty file) and a chunk with no newline", () => {
    fresh();
    const mirror = open();
    expect(mirror.onSessionAppend(appendOf(0, ""))).toBe("ok");
    expect(mirror.onSessionAppend(appendOf(0, '{"type":'))).toBe("ok");
    expect(mirror.facts().size).toBe(0);
  });

  it("an offset that is not the next byte answers the resync and writes nothing", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    const size = mirror.facts().size;
    const before = fileText();
    for (const offset of [0, size - 1, size + 1, size + 4096]) {
      expect(mirror.onSessionAppend(appendOf(offset, entry("e2")))).toEqual({
        resync: { type: "session_resync", fromOffset: size, lastEntryId: "e1" },
      });
    }
    expect(fileText()).toBe(before);
  });

  it("a resync forgets the partial line: the worker resends from the mirror's size", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1").slice(0, 10)));
    expect(mirror.onSessionAppend(appendOf(5, "x"))).toEqual({
      resync: { type: "session_resync", fromOffset: HEADER.length, lastEntryId: "hdr00001" },
    });
    expect(mirror.onSessionAppend(appendOf(HEADER.length, entry("e1")))).toBe("ok");
    expect(fileText()).toBe(HEADER + entry("e1"));
  });

  it("refuses an append that names another file", () => {
    fresh();
    const mirror = open();
    expect(mirror.onSessionAppend(appendOf(0, HEADER, { file: "other.jsonl" }))).toBe("refused");
    expect(refusals()).toEqual([{ agentId: AGENT, reason: "file" }]);
  });

  it("refuses a replace at any offset but 0", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    expect(mirror.onSessionAppend(appendOf(HEADER.length, entry("e1"), { replace: true }))).toBe("refused");
    expect(refusals()).toEqual([{ agentId: AGENT, reason: "offset" }]);
    expect(fileText()).toBe(HEADER);
  });

  it("refuses everything once it refused or closed", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, "{nope\n"));
    expect(mirror.onSessionAppend(appendOf(0, HEADER))).toBe("refused");
    const other = open();
    other.close();
    expect(other.onSessionAppend(appendOf(0, HEADER))).toBe("refused");
  });
});

describe("the line check (R32)", () => {
  it.each([
    ["not_json", "{nope\n"],
    ["not_entry", `${JSON.stringify([1])}\n`],
  ])("refuses %s and writes nothing of the chunk, valid lines before it included", (reason, bad) => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    const size = mirror.facts().size;
    expect(mirror.onSessionAppend(appendOf(size, entry("e1") + bad))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason });
    expect(mirror.facts().size).toBe(size);
    expect(fileText()).toBe(HEADER);
  });

  it("refuses a first line that is not the header", () => {
    fresh();
    const mirror = open();
    expect(mirror.onSessionAppend(appendOf(0, entry("e1")))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "no_header" });
    expect(statSync(bed.path).size).toBe(0);
  });

  it("refuses a second header-shaped line without an id, and accepts the header's shape only first", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    expect(
      mirror.onSessionAppend(appendOf(HEADER.length, `${JSON.stringify({ type: "session", version: 3 })}\n`)),
    ).toBe("refused");
  });

  // Mutant M-DUPLICATE: drop the duplicate check: killed by the next three cases.
  it("refuses a duplicate id, in the mirror, inside one chunk, and against the header's id", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    const size = mirror.facts().size;
    expect(mirror.onSessionAppend(appendOf(size, entry("e1")))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "duplicate_id" });
    fresh();
    const second = open();
    expect(second.onSessionAppend(appendOf(0, HEADER + entry("e2") + entry("e2")))).toBe("refused");
    fresh();
    const third = open();
    expect(third.onSessionAppend(appendOf(0, HEADER + entry("hdr00001")))).toBe("refused");
  });

  it("refuses a duplicate of an id already in the file at open", () => {
    fresh();
    writeFileSync(bed.path, HEADER + entry("e1") + imageEntry("img1", 2 * MiB), { mode: 0o600 });
    const mirror = open();
    const size = mirror.facts().size;
    expect(size).toBe(HEADER.length + entry("e1").length + imageEntry("img1", 2 * MiB).length);
    expect(mirror.onSessionAppend(appendOf(size, entry("img1")))).toBe("refused");
    const again = open();
    expect(again.onSessionAppend(appendOf(size, entry("e1")))).toBe("refused");
    const fine = open();
    expect(fine.onSessionAppend(appendOf(size, entry("e9")))).toBe("ok");
  });

  // Mutant M-HEADID: drop the head/parsed id comparison: killed by this case. JSON.parse keeps the LAST key, the open scan
  // reads the id from the head, so a line with two ids would be stored under one and checked under the other.
  it("refuses a line whose first id differs from the id JSON.parse sees", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    const twice = `{"type":"message","id":"e1x","id":"e1","message":{"role":"assistant","content":"x"}}\n`;
    expect(mirror.onSessionAppend(appendOf(mirror.facts().size, twice))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "not_entry" });
  });

  it("checks the same way the inline check does (no divergence between the two paths)", () => {
    expect(checkMirrorLine(Buffer.from(entry("e1").trim()), false)).toMatchObject({ ok: true });
  });
});

describe("a long line (R32, Review Focus 1)", () => {
  it("a 12 MiB line sent in 6 chunks reads back whole and was parsed in the parse thread", async () => {
    fresh();
    const real = createLineParser({ clock, logger: log.logger });
    const mirror = open({ parser: real });
    const line = imageEntry("img1", 12 * MiB - 400);
    const text = HEADER + line + entry("e2");
    const chunks = 6;
    const step = Math.ceil((HEADER.length + line.length) / chunks);
    let at = 0;
    const results: unknown[] = [];
    for (let i = 0; i < chunks; i++) {
      const piece = text.slice(at, i === chunks - 1 ? HEADER.length + line.length : at + step);
      results.push(await mirror.onSessionAppend(appendOf(at, piece)));
      at += piece.length;
    }
    expect(results.every((r) => r === "ok")).toBe(true);
    expect(statSync(bed.path).size).toBe(HEADER.length + line.length);
    expect(readFileSync(bed.path, "utf8")).toBe(HEADER + line);
    expect(real.stats().threadLines).toBe(1);
    expect(await mirror.onSessionAppend(appendOf(at, entry("e2")))).toBe("ok");
    expect(mirror.facts().lastEntryId).toBe("e2");
  });

  it("answers a Promise for a line over 1 MiB, and plain values for the rest", async () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    const pending = mirror.onSessionAppend(appendOf(HEADER.length, imageEntry("img1", 2 * MiB)));
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe("ok");
    expect(parsed).toBe(1);
    expect(mirror.onSessionAppend(appendOf(mirror.facts().size, entry("e2")))).toBe("ok");
    expect(parsed).toBe(1);
  });

  it("refuses a long line that is a duplicate or not an entry, after the parse, and writes nothing", async () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("img1")));
    const size = mirror.facts().size;
    expect(await mirror.onSessionAppend(appendOf(size, imageEntry("img1", 2 * MiB)))).toBe("refused");
    expect(statSync(bed.path).size).toBe(size);
    const bad = open();
    const junk = `${JSON.stringify(["x".repeat(2 * MiB)])}\n`;
    expect(await bad.onSessionAppend(appendOf(size, junk))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "not_entry" });
  });

  it("writes nothing when the mirror is closed while the line is parsed", async () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    const pending = mirror.onSessionAppend(appendOf(HEADER.length, imageEntry("img1", 2 * MiB)));
    mirror.close();
    expect(await pending).toBe("refused");
    expect(statSync(bed.path).size).toBe(HEADER.length);
  });

  it("refuses at once a line that passes 32 MiB with no newline, and a complete one over it", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    let at = HEADER.length;
    const chunk = Buffer.alloc(2 * MiB, 0x41);
    let last: unknown = "ok";
    let sent = 0;
    while (last === "ok") {
      last = mirror.onSessionAppend(appendOf(at, chunk));
      at += chunk.length;
      sent += chunk.length;
      expect(sent).toBeLessThanOrEqual(MAX_SESSION_LINE_BYTES + chunk.length);
    }
    expect(last).toBe("refused");
    expect(sent).toBe(MAX_SESSION_LINE_BYTES + chunk.length);
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "line_too_large" });
    expect(fileText()).toBe(HEADER);
    fresh();
    const whole = open();
    const huge = Buffer.concat([Buffer.alloc(MAX_SESSION_LINE_BYTES + 1, 0x41), Buffer.from("\n")]);
    expect(whole.onSessionAppend(appendOf(0, huge))).toBe("refused");
    expect(refusals().at(-1)).toEqual({ agentId: AGENT, reason: "line_too_large" });
    expect(statSync(bed.path).size).toBe(0);
  });
});

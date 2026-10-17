import { describe, expect, it } from "vitest";
import { createDeltaGate } from "./delta-gate.ts";
import { createRedactor, NO_REDACTOR } from "./policy/redact.ts";
import type { WireEvent } from "./wire-events.ts";

// W5-R60: the pieces of a message the model is typing leave the worker redacted, even when a value is cut across them.
const SECRET = "pap-test-secret-0a1b2c3d";
const redactor = createRedactor({ entries: [{ name: "TOKEN", value: SECRET }] });
const update = (type: string, extra: Record<string, unknown> = {}, contentIndex = 0): WireEvent => ({
  type: "message_update",
  usage: { input: 1 },
  assistantMessageEvent: { type, contentIndex, ...extra },
});
const delta = (kind: string, text: string, index = 0) => update(`${kind}_delta`, { delta: text }, index);
const textOf = (records: WireEvent[]) =>
  records
    .map((record) => (record["assistantMessageEvent"] as { delta?: string } | undefined)?.delta ?? "")
    .join("");

describe("createDeltaGate", () => {
  it("redacts a value that arrives byte by byte and loses no other text", () => {
    const gate = createDeltaGate(() => redactor);
    const sent = [...`say ${SECRET} twice: ${SECRET}!`].flatMap((char) => gate.apply(delta("text", char)));
    sent.push(...gate.apply(update("text_end", { content: "x" })));
    expect(textOf(sent)).toBe("say [SECRET:TOKEN] twice: [SECRET:TOKEN]!");
    expect(textOf(sent)).not.toContain("pap-test");
  });

  it("redacts a value split across three deltas, for text, thinking and tool-call arguments", () => {
    for (const kind of ["text", "thinking", "toolcall"]) {
      const gate = createDeltaGate(() => redactor);
      const pieces = [
        `{"task":"log in with ${SECRET.slice(0, 7)}`,
        SECRET.slice(7, 15),
        `${SECRET.slice(15)}"}`,
      ];
      const sent = pieces.flatMap((piece) => gate.apply(delta(kind, piece)));
      sent.push(...gate.apply(update(`${kind}_end`)));
      expect(textOf(sent), kind).toBe('{"task":"log in with [SECRET:TOKEN]"}');
    }
  });

  it("holds back only the tail that starts a value, so plain text streams with no lag", () => {
    const gate = createDeltaGate(() => redactor);
    expect(textOf(gate.apply(delta("text", "Hello there, world")))).toBe("Hello there, world");
    const first = gate.apply(delta("text", `${"a".repeat(40)}${SECRET.slice(0, 10)}`));
    expect(textOf(first)).toBe("a".repeat(40));
    expect(textOf(first)).not.toContain("pap");
  });

  it("releases a tail that only looked like a value once the next delta shows it is not one", () => {
    const gate = createDeltaGate(() => redactor);
    expect(textOf(gate.apply(delta("text", "see pap-te")))).toBe("see ");
    expect(textOf(gate.apply(delta("text", "xt files")))).toBe("pap-text files");
  });

  it("covers a value that is added while the message streams", () => {
    let current = NO_REDACTOR as typeof redactor;
    const gate = createDeltaGate(() => current);
    const sent = [...gate.apply(delta("text", "one "))];
    current = redactor;
    sent.push(...gate.apply(delta("text", `two ${SECRET.slice(0, 9)}`)));
    sent.push(...gate.apply(delta("text", SECRET.slice(9))));
    sent.push(...gate.apply(update("text_end")));
    expect(textOf(sent)).toBe("one two [SECRET:TOKEN]");
  });

  it("keeps the blocks of a message apart", () => {
    const gate = createDeltaGate(() => redactor);
    const sent = [
      ...gate.apply(delta("text", `x ${SECRET.slice(0, 12)}`, 0)),
      ...gate.apply(delta("thinking", "plain thought ", 1)),
      ...gate.apply(delta("text", SECRET.slice(12), 0)),
      ...gate.apply(update("text_end", {}, 0)),
      ...gate.apply(update("thinking_end", {}, 1)),
    ];
    const byBlock = (index: number) =>
      textOf(
        sent.filter((r) => (r["assistantMessageEvent"] as { contentIndex?: number }).contentIndex === index),
      );
    expect(byBlock(0)).toBe("x [SECRET:TOKEN]");
    expect(byBlock(1)).toBe("plain thought ");
  });

  it("flushes what it holds before the end of a block, a message, an error and an abort, in that order", () => {
    for (const end of [
      update("text_end"),
      { type: "message_end", message: {} } as WireEvent,
      update("error", { error: "boom" }),
      { type: "agent_end", messages: [] } as WireEvent,
    ]) {
      const gate = createDeltaGate(() => redactor);
      expect(gate.apply(delta("text", "pap-test-se"))).toEqual([]);
      const sent = gate.apply(end);
      expect(sent.at(-1)).toBe(end);
      expect(textOf(sent.slice(0, -1))).toBe("pap-test-se");
    }
  });

  it("passes everything through at once when no secret is known, and passes other events untouched", () => {
    const gate = createDeltaGate(() => NO_REDACTOR);
    const one = delta("text", "plain");
    expect(gate.apply(one)).toEqual([one]);
    const other: WireEvent = { type: "turn_start" };
    expect(gate.apply(other)).toEqual([other]);
  });
});

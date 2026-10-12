import { describe, expect, it } from "vitest";
import { createRedactor, NO_REDACTOR, TOO_DEEP_TEXT } from "./redact.ts";

const set = {
  entries: [
    { name: "GH", value: "ghp_abcdefgh" },
    { name: "LONG", value: "ghp_abcdefgh_more" },
  ],
};

describe("redactor", () => {
  it("replaces every occurrence, longest first, and counts them and the comparisons made", () => {
    const r = createRedactor(set);
    expect(r.text("a ghp_abcdefgh_more b ghp_abcdefgh c")).toEqual({
      text: "a [SECRET:LONG] b [SECRET:GH] c",
      count: 2,
      steps: 3,
    });
    expect(r.text("nothing")).toEqual({ text: "nothing", count: 0, steps: 0 });
  });

  it("walks JSON values, keys included, without touching the input", () => {
    const input = { ghp_abcdefgh: ["x ghp_abcdefgh"], n: 1, deep: { s: "ghp_abcdefgh" } };
    const { value, count } = createRedactor(set).deep(input);
    expect(value).toEqual({ "[SECRET:GH]": ["x [SECRET:GH]"], n: 1, deep: { s: "[SECRET:GH]" } });
    expect(count).toBe(3);
    expect(input.deep.s).toBe("ghp_abcdefgh");
  });

  it("gives keys that collide after redaction distinct names, in key order", () => {
    const { value } = createRedactor(set).deep({ ghp_abcdefgh: 1, "[SECRET:GH]": 2, "[SECRET:GH]~2": 3 });
    expect(value).toEqual({ "[SECRET:GH]": 1, "[SECRET:GH]~2": 2, "[SECRET:GH]~2~2": 3 });
  });

  it("drops function values, which JSON would call or skip: a toJSON cannot bring the secret back", () => {
    const withToJson = { toJSON: () => "ghp_abcdefgh", keep: 1, list: [() => 1, "x"] };
    const { value } = createRedactor(set).deep(withToJson);
    expect(value).toEqual({ keep: 1, list: [null, "x"] });
    expect(JSON.stringify(value)).toBe('{"keep":1,"list":[null,"x"]}');
    expect(createRedactor(set).deep(() => "ghp_abcdefgh").value).toBeNull();
  });

  it("runs a text hook on every string, not on keys, with the name of the field that holds it", () => {
    const seen: Array<[string, string | undefined]> = [];
    const { value } = createRedactor(set).deep(
      { a: "ghp_abcdefgh x", "k ghp_abcdefgh": "y", list: ["z"] },
      { text: (text, field) => (seen.push([text, field]), text.toUpperCase()) },
    );
    expect(value).toEqual({ a: "[SECRET:GH] X", "k [SECRET:GH]": "Y", list: ["Z"] });
    expect(seen).toEqual([
      ["[SECRET:GH] x", "a"],
      ["y", "k ghp_abcdefgh"],
      ["z", "list"],
    ]);
  });

  it("lists as restorable every secret except the ones marked as not", () => {
    const r = createRedactor({
      entries: [
        { name: "ENV", value: "env-value-123" },
        { name: "AUTH", value: "auth-value-123", restorable: false },
      ],
    });
    expect([...r.restorable().entries()]).toEqual([["ENV", "env-value-123"]]);
    expect(r.values().get("AUTH")).toBe("auth-value-123");
  });

  it("is linear: 4 MiB of near misses against 256 secrets costs one comparison per near miss (M5R37)", () => {
    const many = {
      entries: Array.from({ length: 256 }, (_, i) => ({
        name: `S${i}`,
        value: `${i.toString(36).padStart(8, "k")}-secret-tail`,
      })),
    };
    const nearMisses = many.entries.map((entry) => entry.value.slice(0, -1)).join(" ");
    const repeats = Math.ceil((4 * 1024 * 1024) / nearMisses.length);
    const result = createRedactor(many).text(nearMisses.repeat(repeats));
    expect(result.count).toBe(0);
    // A scan per secret would make 256 times as many; the step count, not the clock, is the assertion (RT-16).
    expect(result.steps).toBe(many.entries.length * repeats);
  }, 5_000);

  it("replaces a too-deep subtree instead of throwing when asked to", () => {
    const deep = Array.from({ length: 40 }).reduce<unknown>((inner) => ({ inner }), "ghp_abcdefgh");
    expect(() => createRedactor(set).deep(deep)).toThrow(RangeError);
    expect(JSON.stringify(createRedactor(set).deep(deep, { tooDeep: "replace" }).value)).toContain(
      TOO_DEEP_TEXT,
    );
  });

  it("exposes the names, the values and the size of the set, and NO_REDACTOR knows none", () => {
    const r = createRedactor(set);
    expect(r.size).toBe(2);
    expect(r.values().get("GH")).toBe("ghp_abcdefgh");
    expect(NO_REDACTOR.size).toBe(0);
    expect(NO_REDACTOR.text("ghp_abcdefgh").count).toBe(0);
  });
});

describe("redactor, hostile inputs", () => {
  it("overlap: the match found first wins and the rest stays text; adjacent copies give two markers", () => {
    const r = createRedactor({
      entries: [
        { name: "A", value: "abcdefgh" },
        { name: "B", value: "cdefghij" },
      ],
    });
    expect(r.text("abcdefghij")).toMatchObject({ text: "[SECRET:A]ij", count: 1 });
    expect(r.text("abcdefghabcdefgh")).toMatchObject({ text: "[SECRET:A][SECRET:A]", count: 2 });
  });

  it("a shorter secret never beats a longer one that starts the same way", () => {
    const r = createRedactor({
      entries: [
        { name: "SHORT", value: "abcdefgh" },
        { name: "LONG", value: "abcdefgh-and-more" },
      ],
    });
    expect(r.text("abcdefgh-and-more").text).toBe("[SECRET:LONG]");
  });

  it("unicode: an emoji and a combining accent are replaced exactly, never split", () => {
    const r = createRedactor({
      entries: [
        { name: "EMOJI", value: "key-\u{1F511}-value" },
        { name: "ACCENT", value: "café-secret" },
      ],
    });
    expect(r.text("x key-\u{1F511}-value y café-secret z")).toMatchObject({
      text: "x [SECRET:EMOJI] y [SECRET:ACCENT] z",
      count: 2,
    });
    expect(r.text("cafe-secret").count).toBe(0);
  });

  it("depth and cycles: 33 levels throw, and a cycle is stopped by the depth bound", () => {
    const r = createRedactor(set);
    const levels = (n: number) => Array.from({ length: n }).reduce<unknown>((inner) => ({ inner }), "x");
    expect(() => r.deep(levels(33))).toThrow(RangeError);
    expect(r.deep(levels(31)).count).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => r.deep(cycle)).toThrow(RangeError);
  });

  it("a 4 MiB text that is one secret repeated has every copy replaced, one comparison each", () => {
    const value = "sk-live-0123456789";
    const copies = Math.ceil((4 * 1024 * 1024) / value.length);
    const result = createRedactor({ entries: [{ name: "K", value }] }).text(value.repeat(copies));
    expect(result.count).toBe(copies);
    expect(result.steps).toBe(copies);
    expect(result.text).toBe("[SECRET:K]".repeat(copies));
  });

  it("a value that looks like a marker is replaced in one pass and never scanned again", () => {
    const r = createRedactor({ entries: [{ name: "X", value: "[SECRET:X]xx" }] });
    expect(r.text("a [SECRET:X]xx b").text).toBe("a [SECRET:X] b");
  });

  it("JSON-escaped forms: a secret with a quote, a backslash or a newline is also found in canonical JSON", () => {
    const value = 'pa"ss\\word\nline';
    const r = createRedactor({ entries: [{ name: "P", value }] });
    expect(r.text(`raw ${value} end`).text).toBe("raw [SECRET:P] end");
    expect(r.text(`json ${JSON.stringify({ k: value })}`).text).toBe('json {"k":"[SECRET:P]"}');
    expect(r.size).toBe(1);
    expect(r.entries).toHaveLength(1);
  });

  it("folded matching finds a secret whose case was changed (an audit reason carries a lowercased host)", () => {
    const r = createRedactor({ entries: [{ name: "H", value: "Internal-Host.Example.COM" }] });
    expect(r.text("blocked internal-host.example.com").count).toBe(0);
    expect(r.textFolded("blocked internal-host.example.com here")).toMatchObject({
      text: "blocked [SECRET:H] here",
      count: 1,
    });
    expect(r.textFolded("blocked INTERNAL-HOST.EXAMPLE.COM").text).toBe("blocked [SECRET:H]");
  });

  it("folded matching keeps the original case around the match, and survives text whose lower case is longer", () => {
    const r = createRedactor({ entries: [{ name: "H", value: "Internal-Host" }] });
    expect(r.textFolded("Before INTERNAL-host After").text).toBe("Before [SECRET:H] After");
    // U+0130 lower-cases to two code units: positions would shift, so the whole text is judged on its lower case.
    expect(r.textFolded("İ internal-host").text).not.toContain("nternal-host");
  });
});

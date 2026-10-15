import { afterEach, describe, expect, it } from "vitest";
import "../../i18n/register-automation.ts";
import { setLocale } from "../../i18n/index.ts";
import {
  costText,
  cursorOf,
  detailText,
  durationText,
  keeps,
  mergePage,
  verdictLabel,
  verdictTone,
  whenText,
} from "./journal.vm.ts";
import { fireOf } from "./editor-bed.tsx";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
afterEach(() => setLocale("en"));

describe("verdict chips", () => {
  it("uses the board's tones", () => {
    expect(verdictTone("fired")).toBe("ok");
    expect(verdictTone("dedup")).toBe("mut");
    expect(verdictTone("budget")).toBe("att");
    expect(verdictTone("unauthorized")).toBe("err");
    expect(verdictTone("missed")).toBe("mut");
    expect(verdictTone("error")).toBe("err");
  });

  it("counts a collapsed line in its chip, except a 401 line which counts in its sentence", () => {
    expect(verdictLabel(fireOf({ verdict: "precheck", count: 12 }))).toBe("precheck ×12");
    expect(verdictLabel(fireOf({ verdict: "dedup" }))).toBe("dedup");
    expect(verdictLabel(fireOf({ verdict: "unauthorized", count: 3 }))).toBe("401");
  });
});

describe("filters", () => {
  it("fired keeps the fired lines, refused keeps every other one, all keeps all", () => {
    const lines = [fireOf(), fireOf({ id: 9, verdict: "dedup" }), fireOf({ id: 8, verdict: "unauthorized" })];
    expect(lines.filter((line) => keeps(line, "all"))).toHaveLength(3);
    expect(lines.filter((line) => keeps(line, "fired")).map((line) => line.id)).toEqual([10]);
    expect(lines.filter((line) => keeps(line, "refused")).map((line) => line.id)).toEqual([9, 8]);
  });
});

describe("the detail cell", () => {
  it("builds the 401 sentence from the auth mode and the count (M10R161)", () => {
    expect(detailText(fireOf({ verdict: "unauthorized", detail: "secret", count: 3 }))).toBe(
      "Invalid secret · 3 unauthenticated attempts",
    );
    expect(detailText(fireOf({ verdict: "unauthorized", detail: "hmac", count: 1 }))).toBe(
      "Invalid signature · 1 unauthenticated attempt",
    );
    setLocale("fr");
    expect(detailText(fireOf({ verdict: "unauthorized", detail: "secret", count: 3 }))).toBe(
      "Secret invalide · 3 tentatives non authentifiées",
    );
  });

  it("writes a missed count as a sentence, with a plus for a capped one", () => {
    expect(detailText(fireOf({ verdict: "missed", detail: "3" }))).toBe("3 missed fires");
    expect(detailText(fireOf({ verdict: "missed", detail: "1" }))).toBe("1 missed fire");
    expect(detailText(fireOf({ verdict: "missed", detail: "50+" }))).toBe("50 or more missed fires");
  });

  it("writes hidden characters out and clips an untrusted detail", () => {
    const hostile = detailText(fireOf({ detail: "pod‮evil​" }));
    expect(hostile).toBe("pod\\u202Eevil\\u200B");
    const long = detailText(fireOf({ detail: "x".repeat(500) }));
    expect(Array.from(long)).toHaveLength(121);
    expect(long.endsWith("…")).toBe(true);
    expect(detailText(fireOf({ detail: null }))).toBe("");
  });
});

describe("pages", () => {
  it("appends a page without repeating a line and takes the oldest id as the next cursor", () => {
    const first = [fireOf({ id: 30 }), fireOf({ id: 20 })];
    const merged = mergePage(first, [fireOf({ id: 20 }), fireOf({ id: 10 })]);
    expect(merged.map((line) => line.id)).toEqual([30, 20, 10]);
    expect(cursorOf(merged)).toBe(10);
    expect(cursorOf([])).toBeUndefined();
  });
});

describe("times, duration and cost", () => {
  it("shows the clock time of today's line and the range of a collapsed one", () => {
    const one = whenText(fireOf(), NOW, "en");
    expect(one).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const range = whenText(fireOf({ count: 12, firstAt: NOW - 3_600_000 }), NOW, "en");
    expect(range).toMatch(/^\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2}$/);
  });

  it("shows a dash for what a refusal does not have", () => {
    expect(durationText(fireOf({ durationMs: null }))).toBe("—");
    expect(costText(fireOf({ costUsd: null }))).toBe("—");
    expect(costText(fireOf())).toBe("$0.21");
  });
});

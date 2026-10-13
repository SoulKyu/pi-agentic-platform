import { AUDIT_RATE_LIMIT_REASON, type AuditView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  clipPoints,
  decisionTone,
  isGap,
  resultDetail,
  sessionDetail,
  stageLine,
  timeOf,
} from "./audit.vm.ts";

const base: AuditView = {
  id: 1,
  at: 0,
  actor: "worker",
  actorId: null,
  kind: "call",
  sessionId: "s1",
  toolCallId: null,
  parentToolCallId: null,
  tool: null,
  category: null,
  decision: "info",
  reason: null,
  stages: [],
  args: null,
  detail: null,
};

describe("stageLine", () => {
  it("joins stage and outcome, without the reasons", () => {
    expect(
      stageLine([
        { stage: "01", outcome: "pass" },
        { stage: "03", outcome: "ask", reason: "exec asks" },
      ]),
    ).toBe("01 pass · 03 ask");
  });

  it("is empty for no stages", () => {
    expect(stageLine([])).toBe("");
  });
});

describe("decisionTone", () => {
  it("maps each decision to its chip", () => {
    expect(decisionTone("allow")).toBe("ok");
    expect(decisionTone("approved")).toBe("ok");
    expect(decisionTone("denied")).toBe("att");
    expect(decisionTone("block")).toBe("err");
    expect(decisionTone("info")).toBe("mut");
  });
});

describe("clipPoints", () => {
  it("strips invisible controls, then clips by code points with an ellipsis", () => {
    const hostile = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x200b)}c${String.fromCodePoint(0)}${"😀".repeat(10)}`;
    expect(clipPoints(hostile, 5)).toEqual({
      text: "abc😀😀…",
      clipped: true,
      full: `abc${"😀".repeat(10)}`,
    });
  });

  it("leaves a short text alone", () => {
    expect(clipPoints("abc", 5)).toEqual({ text: "abc", clipped: false, full: "abc" });
  });
});

describe("sessionDetail", () => {
  it("reads the mode and the tool names", () => {
    expect(sessionDetail({ mode: "supervised", count: 3, truncated: true, names: ["a", "b"] })).toEqual({
      mode: "supervised",
      names: ["a", "b"],
      count: 3,
      truncated: true,
    });
  });

  it("copes with an old row without a mode, and with garbage", () => {
    expect(sessionDetail({ count: 1, names: ["a"] })).toEqual({
      mode: null,
      names: ["a"],
      count: 1,
      truncated: false,
    });
    expect(sessionDetail({ mode: 4, names: "x", count: "y", truncated: "yes" })).toEqual({
      mode: null,
      names: [],
      count: 0,
      truncated: false,
    });
    expect(sessionDetail(null)).toEqual({ mode: null, names: [], count: 0, truncated: false });
  });
});

describe("resultDetail", () => {
  it("reads redactions and external, and nothing else", () => {
    expect(resultDetail({ redactions: 2, external: true })).toEqual({ redactions: 2, external: true });
    expect(resultDetail({ redactions: "2" })).toEqual({ redactions: 0, external: false });
    expect(resultDetail(null)).toEqual({ redactions: 0, external: false });
  });
});

describe("isGap", () => {
  it("is the rate-limit marker of the audit kind only", () => {
    const marker = { ...base, kind: "audit" as const, reason: AUDIT_RATE_LIMIT_REASON };
    expect(isGap(marker)).toBe(true);
    expect(isGap({ ...marker, kind: "call" })).toBe(false);
    expect(isGap({ ...marker, reason: "other" })).toBe(false);
  });
});

describe("timeOf", () => {
  it("formats in the locale, and is empty for an impossible date", () => {
    expect(timeOf(Date.UTC(2026, 9, 12, 10), "en")).toBe(
      new Date(Date.UTC(2026, 9, 12, 10)).toLocaleString("en"),
    );
    expect(timeOf(Number.MAX_SAFE_INTEGER, "en")).toBe("");
  });
});

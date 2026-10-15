import { describe, expect, it } from "vitest";
import { deriveLaneStatus } from "./lane-status.ts";
import type { LaneView } from "./lanes.ts";

type Setup = LaneView["setup"]["state"];
const lane = (state: LaneView["state"], setup: Setup, pr?: "merged" | "open") => ({
  state,
  setup: { state: setup, exitCode: null, startedAt: null, finishedAt: null },
  pr: pr === undefined ? null : ({ state: pr } as NonNullable<LaneView["pr"]>),
});
const none = { busy: false, needsInput: false };
const busy = { busy: true, needsInput: false };

describe("deriveLaneStatus", () => {
  const rows: [string, ReturnType<typeof lane>, typeof none, string, string | null][] = [
    ["archived", lane("archived", "ok"), none, "archived", null],
    ["running setup, busy", lane("active", "running"), busy, "setup", null],
    ["queued setup", lane("active", "queued"), none, "setup", null],
    [
      "input needed",
      lane("active", "ok"),
      { busy: true, needsInput: true },
      "needs_attention",
      "input_needed",
    ],
    ["failed setup but busy", lane("active", "failed"), busy, "working", null],
    ["pending setup but busy", lane("active", "pending"), busy, "working", null],
    ["merged", lane("active", "failed", "merged"), none, "done", null],
    ["open", lane("active", "ok", "open"), none, "in_review", null],
    ["setup failed", lane("active", "failed"), none, "needs_attention", "setup_failed"],
    ["create failed", lane("failed", "none"), none, "needs_attention", "create_failed"],
    ["interrupted", lane("active", "interrupted"), none, "needs_attention", "setup_interrupted"],
    ["unapproved", lane("active", "unapproved"), none, "needs_attention", "setup_unapproved"],
    ["pending", lane("active", "pending"), none, "needs_attention", "setup_pending"],
    ["idle", lane("active", "ok"), none, "idle", null],
  ];
  it.each(rows)("%s", (_name, view, facts, status, reason) => {
    expect(deriveLaneStatus(view, facts)).toEqual({ status, reason });
  });
});

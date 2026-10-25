import { describe, expect, it } from "vitest";
import { laneView } from "../../testing/lane-fixtures.ts";
import { headerModel, noticeModels, showsRunSetup } from "./lane-header.vm.ts";

const quiet = { cwd: "/p/worktrees/a-1a2b", status: "idle", needsInput: false };
const busy = { ...quiet, status: "running" };
const waiting = { ...quiet, needsInput: true };
const lane = (patch = {}) => laneView({ id: "a-1a2b", ...patch });

describe("status chip", () => {
  it("is a word and a tone per status", () => {
    const pr = (state: "open" | "merged") => ({
      number: 1,
      url: "https://x/1",
      state,
      draft: false,
      conflicts: null,
      checks: null,
      checkedAt: null,
      error: null,
    });
    const cases = [
      [lane(), [busy], "working", "run"],
      [lane(), [waiting], "needs_attention", "att"],
      [lane({ pr: pr("open") }), [quiet], "in_review", "you"],
      [lane({ pr: pr("merged") }), [quiet], "done", "ok"],
      [lane(), [quiet], "idle", "mut"],
    ] as const;
    for (const [view, sessions, status, tone] of cases) {
      const model = headerModel(view, sessions);
      expect([model.status, model.tone]).toEqual([status, tone]);
    }
  });

  it("names the reason as a second word", () => {
    const reason = (patch: object) => headerModel(lane(patch), [quiet]).reason;
    expect(reason({ setup: { ...lane().setup, state: "failed" } })).toBe("lanes.reason.setup_failed");
    expect(reason({ setup: { ...lane().setup, state: "interrupted" } })).toBe(
      "lanes.reason.setup_interrupted",
    );
    expect(reason({ setup: { ...lane().setup, state: "unapproved" } })).toBe("lanes.reason.setup_unapproved");
    expect(reason({ setup: { ...lane().setup, state: "pending" } })).toBe("lanes.reason.setup_pending");
    expect(headerModel(lane(), [waiting]).reason).toBe("lanes.reason.input_needed");
    expect(reason({})).toBeNull();
  });

  it("says why a create failed", () => {
    for (const failedReason of ["git", "prepare", "disk", "interrupted"] as const)
      expect(headerModel(lane({ state: "failed", failedReason }), [quiet]).reason).toBe(
        `lanes.reason.create_failed.${failedReason}`,
      );
    expect(headerModel(lane({ state: "failed" }), [quiet]).reason).toBe("lanes.reason.create_failed");
  });

  it("marks a lane that came from an issue as external content", () => {
    const issue = { kind: "issue", forge: "github", url: "https://x/1", number: 1 } as const;
    expect(headerModel(lane({ source: issue }), [quiet]).external).toBe(true);
    expect(headerModel(lane(), [quiet]).external).toBe(false);
  });
});

describe("facts", () => {
  it("writes numbers with a dash for null", () => {
    expect(headerModel(lane(), [quiet]).facts).toEqual({
      branch: "pi/a-1a2b",
      base: "main",
      ahead: "—",
      behind: "—",
      additions: "—",
      deletions: "—",
    });
    const facts = {
      dirty: 2,
      ahead: 3,
      behind: 0,
      unpushed: null,
      additions: 10,
      deletions: 4,
      checkedAt: 1,
      error: null,
    };
    expect(headerModel(lane({ facts }), [quiet]).facts).toMatchObject({
      ahead: "3",
      behind: "0",
      additions: "10",
      deletions: "4",
    });
  });
});

describe("pull request badge", () => {
  const pr = (patch: object) => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "open",
    draft: false,
    conflicts: null,
    checks: null,
    checkedAt: 1,
    error: null,
    ...patch,
  });
  const badge = (patch: object) => headerModel(lane({ pr: pr(patch) as never }), [quiet]).pr;

  it("is absent without a pull request", () => expect(headerModel(lane(), [quiet]).pr).toBeNull());

  it("shows the number and the state, draft before open", () => {
    expect(badge({})).toMatchObject({ number: 7, state: "lanes.pr.state.open" });
    expect(badge({ draft: true })).toMatchObject({ state: "lanes.pr.state.draft" });
    expect(badge({ state: "merged" })).toMatchObject({ state: "lanes.pr.state.merged" });
    expect(badge({ state: "closed" })).toMatchObject({ state: "lanes.pr.state.closed" });
    expect(badge({ state: null })).toMatchObject({ state: null });
  });

  it("lists the checks that have a count, and the conflicts", () => {
    expect(badge({ checks: { total: 6, passed: 4, failed: 1, pending: 1 }, conflicts: true })).toMatchObject({
      checks: [
        { count: 4, kind: "passed" },
        { count: 1, kind: "failed" },
        { count: 1, kind: "pending" },
      ],
      conflicts: true,
    });
    expect(badge({ checks: { total: 2, passed: 2, failed: 0, pending: 0 } })?.checks).toHaveLength(1);
  });

  it("carries an error word", () =>
    expect(badge({ error: "not_signed_in" })?.error).toBe("lanes.pr.error.not_signed_in"));

  it("links only an http(s) address", () => {
    expect(badge({})?.href).toBe("https://github.com/o/r/pull/7");
    expect(badge({ url: "javascript:alert(1)" })?.href).toBeNull();
  });
});

describe("notices", () => {
  it("come newest first, with a plural form for a count", () => {
    const models = noticeModels([
      { kind: "disk_low", at: 10, count: null },
      { kind: "large_files_skipped", at: 30, count: 3 },
      { kind: "copy_skipped", at: 20, count: 1 },
    ]);
    expect(models.map((one) => one.id)).toEqual(["large_files_skipped:30", "copy_skipped:20", "disk_low:10"]);
    expect(models[0]).toMatchObject({ plural: "lanes.notice.large_files_skipped", count: 3 });
    expect(models[2]).toMatchObject({ key: "lanes.notice.disk_low", plural: null });
  });

  it("counts the nested repositories left out of a commit", () => {
    const [one] = noticeModels([{ kind: "nested_repo_left_out", at: 5, count: 2 }]);
    expect(one).toMatchObject({ plural: "lanes.notice.nested_repo_left_out", count: 2 });
  });

  it("offers Start session on a session that could not start only", () => {
    const [failed, refused] = noticeModels([
      { kind: "session_failed", at: 2, count: null },
      { kind: "model_refused", at: 1, count: null },
    ]);
    expect(failed?.startSession).toBe(true);
    expect(refused?.startSession).toBe(false);
  });
});

describe("Run setup", () => {
  it.each([
    ["pending", true],
    ["failed", true],
    ["interrupted", true],
    ["unapproved", true],
    ["ok", false],
    ["none", false],
    ["queued", false],
    ["running", false],
  ] as const)("setup %s -> %s", (state, shown) =>
    expect(showsRunSetup(lane({ setup: { ...lane().setup, state } }))).toBe(shown),
  );

  it("is not offered on a lane that is not active", () =>
    expect(showsRunSetup(lane({ state: "failed", setup: { ...lane().setup, state: "failed" } }))).toBe(
      false,
    ));
});

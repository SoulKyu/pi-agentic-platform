import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/index.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { vcsFile } from "../../testing/m8-fixtures.ts";
import {
  COMMIT_REFUSED,
  commitPaths,
  PUSH_REFUSED,
  pushModel,
  SUGGEST_REFUSED,
  tickedCount,
} from "./commit-bar.vm.ts";
import "./register-lane-commit-catalog.ts";

const facts = (patch: object) => ({
  dirty: 0,
  ahead: 3,
  behind: 0,
  unpushed: null,
  additions: 0,
  deletions: 0,
  checkedAt: 1,
  error: null,
  ...patch,
});
const remote = { host: "github.com", path: "o/r" };
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("en", key, vars);
const label = (lane = laneView({ id: "a-1a2b" })) => {
  const model = pushModel(lane);
  return { ...model, text: en(model.label.key, model.label.vars) };
};

describe("push button", () => {
  it("names the target before the first push, with the commits ahead of the base", () => {
    const lane = laneView({ id: "a-1a2b", pushRemote: remote, remote, facts: facts({ ahead: 3 }) });
    expect(label(lane).text).toBe("Push ↑3 → github.com/o/r");
  });

  it("counts the commits not on the upstream once a first push set one", () => {
    const lane = laneView({
      id: "a-1a2b",
      pushRemote: remote,
      remote,
      facts: facts({ ahead: 5, unpushed: 2 }),
    });
    expect(label(lane).text).toBe("Push ↑2 → github.com/o/r");
    expect(label(lane).count).toBe(2);
  });

  it("reads a lane that was pushed completely as nothing to push", () => {
    const lane = laneView({
      id: "a-1a2b",
      pushRemote: remote,
      remote,
      facts: facts({ ahead: 5, unpushed: 0 }),
    });
    expect(label(lane).count).toBe(0);
  });

  it("shows a dash while the facts are unknown", () => {
    const lane = laneView({ id: "a-1a2b", pushRemote: remote, remote, facts: null });
    expect(label(lane).text).toBe("Push ↑— → github.com/o/r");
  });

  it("says why there is no target: no remote at all, or one pap cannot place", () => {
    const none = label(laneView({ id: "a-1a2b", facts: facts({}) }));
    expect(none.text).toBe("Push ↑3");
    expect(none.target).toBeNull();
    expect(none.whyNot && en(none.whyNot)).toBe(
      "This repository has no remote to push to: add one in the terminal",
    );
    const odd = label(laneView({ id: "a-1a2b", remote, facts: facts({}) }));
    expect(odd.whyNot && en(odd.whyNot)).toBe(
      "pap cannot tell where this remote goes: push from the terminal",
    );
  });

  it("writes hidden characters of the target as escapes", () => {
    const lane = laneView({
      id: "a-1a2b",
      pushRemote: { host: "git.example", path: "o/‮r" },
      facts: facts({}),
    });
    expect(label(lane).text).toBe("Push ↑3 → git.example/o/\\u202Er");
  });
});

describe("refusals in words", () => {
  it("commit", () => {
    expect(Object.keys(COMMIT_REFUSED).sort()).toEqual(
      ["conflicted", "failed", "identity_missing", "nothing_to_commit"].sort(),
    );
    expect(en(COMMIT_REFUSED.nothing_to_commit)).toBe("Nothing to commit in the ticked files");
    expect(en(COMMIT_REFUSED.identity_missing)).toBe(
      "Git needs your name and email: set user.name and user.email in the terminal",
    );
    expect(en(COMMIT_REFUSED.conflicted)).toBe("Resolve the conflicts first");
    expect(en(COMMIT_REFUSED.failed)).toBe("Commit failed: see the daemon log");
  });

  it("push", () => {
    expect(Object.keys(PUSH_REFUSED).sort()).toEqual(
      ["auth", "failed", "network", "no_remote", "rejected", "repo_config", "unsupported_remote"].sort(),
    );
    expect(en(PUSH_REFUSED.repo_config)).toBe(
      "This repository's own git config names a program, or sends pushes elsewhere (a pushurl, a second url). Push from the terminal, or remove those keys.",
    );
    expect(en(PUSH_REFUSED.rejected)).toBe(
      "The remote has commits this lane does not have: pull them in the terminal first",
    );
  });

  it("suggest", () => {
    expect(Object.keys(SUGGEST_REFUSED).sort()).toEqual(["model_failed", "no_session", "nothing"]);
  });
});

describe("ticked files", () => {
  const files = [vcsFile("a.ts"), vcsFile("b.ts"), vcsFile("new.ts", { oldPath: "old.ts", kind: "renamed" })];

  it("takes every file by default and leaves out the unticked ones", () => {
    expect(commitPaths(files, new Set())).toEqual(["a.ts", "b.ts", "new.ts", "old.ts"]);
    expect(commitPaths(files, new Set(["b.ts"]))).toEqual(["a.ts", "new.ts", "old.ts"]);
    expect(tickedCount(files, new Set(["b.ts", "a.ts"]))).toBe(1);
  });

  it("sends a renamed file's old path with the new one, once", () => {
    const both = [...files, vcsFile("old.ts", { kind: "deleted", worktree: "D" })];
    expect(commitPaths(both, new Set())).toEqual(["a.ts", "b.ts", "new.ts", "old.ts"]);
  });
});

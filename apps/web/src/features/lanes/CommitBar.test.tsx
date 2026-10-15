// @vitest-environment happy-dom
import type { LaneView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  press,
  settle,
  text,
  typeInto,
} from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { vcsFile, vcsStatus } from "../../testing/m8-fixtures.ts";
import { CommitBar } from "./CommitBar.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const root = "/p/worktrees/a-1a2b";
const remote = { host: "github.com", path: "o/r" };
const facts = (patch: object = {}) => ({
  dirty: 2,
  ahead: 3,
  behind: 0,
  unpushed: null,
  additions: 0,
  deletions: 0,
  checkedAt: 1,
  error: null,
  ...patch,
});
const oid = "a".repeat(40);

async function show(patch: Partial<LaneView> = {}, paths = ["a.ts", "b.ts"]) {
  useLaneStore
    .getState()
    .apply(laneSnapshot([laneView({ id: "a-1a2b", pushRemote: remote, remote, facts: facts(), ...patch })]));
  const bed = newBed();
  const page = await mount(inShell(<CommitBar laneId="a-1a2b" worktree={root} />));
  useVcsStore.getState().apply(root, {
    kind: "snapshot",
    status: vcsStatus(root, { files: paths.map((path) => vcsFile(path)) }),
  });
  await settle();
  return { bed, page, box: page.container };
}
const message = (box: HTMLElement) => field(box, "Commit message") as HTMLTextAreaElement;
const write = (box: HTMLElement, value: string) => typeInto(message(box), value);
const tick = (box: HTMLElement, label: string) =>
  [...box.querySelectorAll('[role="checkbox"]')].find(
    (node) => node.closest("label")?.textContent === label,
  ) as HTMLElement;

beforeEach(() => {
  useLaneStore.getState().reset();
  useVcsStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe("commit bar: files", () => {
  it("watches the worktree's changes and ticks every file", async () => {
    const { bed, box } = await show();
    expect(bed.called("subscribe.vcs")[0]?.params).toMatchObject({ root });
    expect(text(box)).toContain("2 of 2 files");
  });

  it("opens the checklist, and an unticked file leaves the commit", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.commit"] = () => ({ ok: true, oid });
    await click(button(box, "2 of 2 files"));
    await click(tick(box, "b.ts"));
    expect(text(box)).toContain("1 of 2 files");
    await write(box, "feat: a");
    await click(button(box, "Commit"));
    await settle();
    expect(bed.called("lanes.commit")[0]?.params).toEqual({
      laneId: "a-1a2b",
      paths: ["a.ts"],
      message: "feat: a",
    });
  });

  it("commits and suggests nothing when no file is ticked", async () => {
    const { box } = await show();
    await click(button(box, "2 of 2 files"));
    await click(button(box, "Untick all"));
    await write(box, "feat: a");
    expect(button(box, "Commit").disabled).toBe(true);
    expect(button(box, "✦ Suggest").disabled).toBe(true);
    await click(button(box, "Tick all"));
    expect(button(box, "Commit").disabled).toBe(false);
  });

  it("writes hidden characters of a file name as escapes", async () => {
    const { box } = await show({}, ["a‮b.ts"]);
    await click(button(box, "1 of 1 file"));
    expect(text(box)).toContain("a\\u202Eb.ts");
    expect(text(box)).not.toContain("‮");
  });

  it("says when the list was cut", async () => {
    const { box } = await show();
    useVcsStore.getState().apply(root, {
      kind: "status",
      status: vcsStatus(root, { files: [vcsFile("a.ts")], truncated: true }),
    });
    await settle();
    await click(button(box, "1 of 1 file"));
    expect(text(box)).toContain("Only the first 1 changed files are listed.");
  });
});

describe("commit bar: commit", () => {
  it("stays disabled until there is a message", async () => {
    const { box } = await show();
    expect(button(box, "Commit").disabled).toBe(true);
    await write(box, "   ");
    expect(button(box, "Commit").disabled).toBe(true);
    await write(box, "feat: a");
    expect(button(box, "Commit").disabled).toBe(false);
  });

  it("commits the ticked paths under a command id, then clears the message", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.commit"] = () => ({ ok: true, oid });
    await write(box, "feat: a");
    await click(button(box, "Commit"));
    await settle();
    const call = bed.called("lanes.commit")[0];
    expect(call?.params).toEqual({ laneId: "a-1a2b", paths: ["a.ts", "b.ts"], message: "feat: a" });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(message(box).value).toBe("");
    expect(text(box)).toContain("Committed aaaaaaa");
  });

  it("Mod-Enter commits, and only with a message", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.commit"] = () => ({ ok: true, oid });
    await press(message(box), { key: "Enter", ctrlKey: true });
    await settle();
    expect(bed.called("lanes.commit")).toHaveLength(0);
    await write(box, "feat: a");
    const event = await press(message(box), { key: "Enter", metaKey: true });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(bed.called("lanes.commit")).toHaveLength(1);
  });

  it("a plain Enter adds a line, it does not commit", async () => {
    const { bed, box } = await show();
    await write(box, "feat: a");
    await press(message(box), { key: "Enter" });
    expect(bed.called("lanes.commit")).toHaveLength(0);
  });

  it.each([
    ["nothing_to_commit", "Nothing to commit in the ticked files"],
    ["identity_missing", "Git needs your name and email: set user.name and user.email in the terminal"],
    ["conflicted", "Resolve the conflicts first"],
    ["failed", "Commit failed: see the daemon log"],
  ])("answers %s in words and keeps the message", async (reason, words) => {
    const { bed, box } = await show();
    bed.handlers["lanes.commit"] = () => ({ ok: false, reason });
    await write(box, "feat: a");
    await click(button(box, "Commit"));
    await settle();
    expect(alerts(box)).toContain(words);
    expect(message(box).value).toBe("feat: a");
  });

  it("a timeout says the outcome is unknown", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.commit"] = () => {
      throw new RpcError("timeout");
    };
    await write(box, "feat: a");
    await click(button(box, "Commit"));
    await settle();
    expect(alerts(box)[0]).toContain("may still have gone through");
    expect(message(box).value).toBe("feat: a");
  });

  it("disables at once and names the stage after 3 s (DESIGN 7.3)", async () => {
    let now = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { bed, box } = await show();
    let finish: (value: unknown) => void = () => {};
    bed.handlers["lanes.commit"] = () => new Promise((resolve) => (finish = resolve));
    await write(box, "feat: a");
    await click(button(box, "Commit"));
    expect(button(box, "Commit").disabled).toBe(true);
    expect(button(box, "✦ Suggest").disabled).toBe(true);
    expect(box.querySelector("button[aria-busy]")).not.toBeNull();
    now = 3100;
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(hasButton(box, "Committing…")).toBe(true);
    await click(button(box, "Committing…"));
    expect(bed.called("lanes.commit")).toHaveLength(1);
    finish({ ok: true, oid });
    await act(async () => {
      await Promise.resolve();
    });
    vi.restoreAllMocks();
  });
});

describe("commit bar: suggest", () => {
  it("fills an empty field with the suggestion, asking with the ticked paths", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => ({ ok: true, message: "feat: from the model" });
    await click(button(box, "✦ Suggest"));
    await settle();
    expect(bed.called("lanes.suggestCommit")[0]?.params).toEqual({
      laneId: "a-1a2b",
      paths: ["a.ts", "b.ts"],
    });
    expect(bed.called("lanes.suggestCommit")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(message(box).value).toBe("feat: from the model");
  });

  it("asks before it replaces a typed message, and keeps it on Keep mine", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => ({ ok: true, message: "feat: from the model" });
    await write(box, "my own words");
    await click(button(box, "✦ Suggest"));
    await settle();
    expect(message(box).value).toBe("my own words");
    expect(text(box)).toContain("Replace your message with this suggestion?");
    expect(text(box)).toContain("feat: from the model");
    await click(button(box, "Keep mine"));
    expect(message(box).value).toBe("my own words");
    expect(text(box)).not.toContain("Replace your message");
  });

  it("replaces the typed message after Replace", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => ({ ok: true, message: "feat: from the model" });
    await write(box, "my own words");
    await click(button(box, "✦ Suggest"));
    await settle();
    await click(button(box, "Replace"));
    expect(message(box).value).toBe("feat: from the model");
  });

  it("asks when the person typed while the model was thinking", async () => {
    const { bed, box } = await show();
    let finish: (value: unknown) => void = () => {};
    bed.handlers["lanes.suggestCommit"] = () => new Promise((resolve) => (finish = resolve));
    await click(button(box, "✦ Suggest"));
    await write(box, "typed meanwhile");
    finish({ ok: true, message: "feat: from the model" });
    await settle();
    expect(message(box).value).toBe("typed meanwhile");
    expect(text(box)).toContain("Replace your message with this suggestion?");
  });

  it("shows the suggestion as text", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => ({ ok: true, message: "<img src=x onerror=alert(1)>" });
    await click(button(box, "✦ Suggest"));
    await settle();
    expect(message(box).value).toBe("<img src=x onerror=alert(1)>");
    expect(box.querySelector("img")).toBeNull();
  });

  it.each([
    ["nothing", "There is nothing to describe in the ticked files"],
    ["no_session", "this lane has no session: start one first"],
    ["model_failed", "The model gave no message: write it yourself"],
  ])("answers %s in words", async (reason, words) => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => ({ ok: false, reason });
    await click(button(box, "✦ Suggest"));
    await settle();
    expect(alerts(box)[0]).toContain(words);
  });

  it.each([
    ["capacity", "at capacity"],
    ["worker_failed", "The session process failed"],
  ])("maps the error %s", async (code, words) => {
    const { bed, box } = await show();
    bed.handlers["lanes.suggestCommit"] = () => {
      throw new RpcError(code as "capacity");
    };
    await click(button(box, "✦ Suggest"));
    await settle();
    expect(alerts(box)[0]).toContain(words);
  });
});

describe("commit bar: push", () => {
  it("names the target before the first push", async () => {
    const { box } = await show();
    expect(hasButton(box, "Push ↑3 → github.com/o/r")).toBe(true);
  });

  it("counts the unpushed commits after a first push", async () => {
    const { box } = await show({ facts: facts({ ahead: 5, unpushed: 1 }) });
    expect(hasButton(box, "Push ↑1 → github.com/o/r")).toBe(true);
  });

  it("pushes under a command id and says where", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.push"] = () => ({ ok: true, remote });
    await click(button(box, "Push ↑3 → github.com/o/r"));
    await settle();
    const call = bed.called("lanes.push")[0];
    expect(call?.params).toEqual({ laneId: "a-1a2b" });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(text(box)).toContain("Pushed to github.com/o/r");
  });

  it("is disabled, and says why, without a target", async () => {
    const { box } = await show({ pushRemote: null, remote: null });
    expect(button(box, "Push ↑3").disabled).toBe(true);
    expect(text(box)).toContain("This repository has no remote to push to: add one in the terminal");
  });

  it("has nothing to push when everything is on the remote", async () => {
    const { box } = await show({ facts: facts({ unpushed: 0 }) });
    expect(button(box, "Push ↑0 → github.com/o/r").disabled).toBe(true);
  });

  it.each([
    [
      "repo_config",
      "This repository's own git config names a program, or sends pushes elsewhere (a pushurl, a second url). Push from the terminal, or remove those keys.",
    ],
    ["rejected", "The remote has commits this lane does not have: pull them in the terminal first"],
    ["auth", "The remote refused the sign-in"],
    ["network", "The remote could not be reached"],
    ["no_remote", "no remote to push to"],
    ["unsupported_remote", "pap cannot tell where this remote goes"],
    ["failed", "The push failed"],
  ])("answers %s in words", async (reason, words) => {
    const { bed, box } = await show();
    bed.handlers["lanes.push"] = () => ({ ok: false, reason });
    await click(button(box, "Push ↑3 → github.com/o/r"));
    await settle();
    expect(alerts(box)[0]).toContain(words);
  });
});

describe("commit bar: when it shows", () => {
  it("shows nothing for a lane that is not active", async () => {
    const { box } = await show({ state: "archiving" });
    expect(box.querySelector("[data-slot='lane-commit-bar']")).toBeNull();
  });
});

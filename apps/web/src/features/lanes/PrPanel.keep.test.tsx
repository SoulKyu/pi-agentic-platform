// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { translate } from "../../i18n/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { vcsFile, vcsStatus } from "../../testing/m8-fixtures.ts";
import { CommitBar } from "./CommitBar.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";
import "./register-lane-commit-catalog.ts";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const root = "/p/worktrees/a-1a2b";
const remote = { host: "github.com", path: "o/r" };
const facts = {
  dirty: 1,
  ahead: 2,
  behind: 0,
  unpushed: null,
  additions: 0,
  deletions: 0,
  checkedAt: 1,
  error: null,
};

async function show() {
  useLaneStore
    .getState()
    .apply(laneSnapshot([laneView({ id: "a-1a2b", forge: "github", pushRemote: remote, remote, facts })]));
  const bed = newBed();
  const page = await mount(inShell(<CommitBar laneId="a-1a2b" worktree={root} />));
  useVcsStore
    .getState()
    .apply(root, { kind: "snapshot", status: vcsStatus(root, { files: [vcsFile("a.ts")] }) });
  await settle();
  return { bed, box: page.container };
}
const toggle = (box: HTMLElement) => click(button(box, "Pull request"));

beforeEach(() => {
  useLaneStore.getState().reset();
  useVcsStore.getState().reset();
});

describe("pull request panel survives being closed", () => {
  it("after a create timeout, closing and reopening the panel still offers only the check", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => {
      throw new RpcError("timeout");
    };
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    expect(hasButton(box, "Check for the pull request")).toBe(true);
    await toggle(box);
    await toggle(box);
    expect(hasButton(box, "Create PR")).toBe(false);
    expect(hasButton(box, "Check for the pull request")).toBe(true);
    expect(bed.called("lanes.prCreate")).toHaveLength(1);
  });

  it("keeps the state through a remount of the whole bar (a tab switch)", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => {
      throw new RpcError("timeout");
    };
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    const again = await mount(inShell(<CommitBar laneId="a-1a2b" worktree={root} />));
    await toggle(again.container);
    expect(hasButton(again.container, "Create PR")).toBe(false);
    expect(hasButton(again.container, "Check for the pull request")).toBe(true);
  });

  it("does not offer a second create while the first still runs, even after a close and reopen", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => new Promise(() => undefined);
    await toggle(box);
    await click(button(box, "Create PR"));
    await toggle(box);
    await toggle(box);
    expect(button(box, "Create PR").disabled).toBe(true);
    await click(button(box, "Create PR"));
    expect(bed.called("lanes.prCreate")).toHaveLength(1);
  });

  it("a check that finds nothing makes Create available again, for good", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => {
      throw new RpcError("timeout");
    };
    bed.handlers["lanes.prRefresh"] = () => ({ pr: null });
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    await click(button(box, "Check for the pull request"));
    await settle();
    await toggle(box);
    await toggle(box);
    expect(hasButton(box, "Create PR")).toBe(true);
  });

  it("tells the owner an empty description uses the lane's own", async () => {
    const { box } = await show();
    await toggle(box);
    expect(text(box)).toContain("Empty: the lane's description is used");
    expect(translate("fr", "laneCommit.pr.bodyHint")).toBe(
      "Vide\u202f: la description de la lane est utilisée",
    );
  });
});

describe("Push and create names where the push goes (M9)", () => {
  it("shows the same target as the commit bar, and says it plainly when there is none", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => ({ ok: false, reason: "not_pushed" });
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    expect(hasButton(box, "Push and create → github.com/o/r")).toBe(true);
    expect(translate("fr", "laneCommit.pr.pushAndCreate.to", { target: "h/p" })).toBe(
      "Pousser et créer → h/p",
    );
  });
});

describe("one guard for every push", () => {
  const notPushed = (bed: Awaited<ReturnType<typeof show>>["bed"]) => {
    bed.handlers["lanes.prCreate"] = () => ({ ok: false, reason: "not_pushed" });
  };

  it("the bar's Push cannot start while Push and create is pushing", async () => {
    const { bed, box } = await show();
    notPushed(bed);
    bed.handlers["lanes.push"] = () => new Promise(() => undefined);
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    await click(button(box, "Push and create → github.com/o/r"));
    expect(button(box, "Push ↑2 → github.com/o/r").disabled).toBe(true);
    await click(button(box, "Push ↑2 → github.com/o/r"));
    expect(bed.called("lanes.push")).toHaveLength(1);
  });

  it("Push and create cannot start while the bar's Push is pushing", async () => {
    const { bed, box } = await show();
    notPushed(bed);
    bed.handlers["lanes.push"] = () => new Promise(() => undefined);
    await toggle(box);
    await click(button(box, "Create PR"));
    await settle();
    await click(button(box, "Push ↑2 → github.com/o/r"));
    expect(button(box, "Push and create → github.com/o/r").disabled).toBe(true);
    await click(button(box, "Push and create → github.com/o/r"));
    expect(bed.called("lanes.push")).toHaveLength(1);
  });
});

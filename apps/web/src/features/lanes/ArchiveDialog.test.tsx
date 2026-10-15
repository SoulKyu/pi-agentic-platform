// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, hasButton, mount, press, settle, text } from "../../testing/dom.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { ArchiveDialog } from "./ArchiveDialog.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const lane = laneView({ id: "a-1a2b", branch: "pi/a" });
const body = () => text(document.body);
const box = (label: string) =>
  [...document.querySelectorAll('[role="checkbox"]')].find((node) =>
    node.closest("label")?.textContent?.startsWith(label),
  ) as HTMLElement;

let closed = vi.fn();
beforeEach(() => {
  closed = vi.fn();
});

let clock = 1000;
const afterGuard = () => {
  clock += 600;
};

async function open(answer: unknown = { ok: true, branchDeleted: null }) {
  clock += 10_000;
  const bed = newBed();
  bed.handlers["lanes.archive"] = () => answer;
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const page = await mount(inShell(<ArchiveDialog lane={lane} onClose={closed} now={() => clock} />));
  await settle();
  return { bed, trigger, page };
}

describe("archive dialog", () => {
  it("starts with Force and Delete branch unchecked, and Archive is not danger", async () => {
    await open();
    expect(box("Force")?.getAttribute("aria-checked")).toBe("false");
    expect(box("Delete branch")?.getAttribute("aria-checked")).toBe("false");
    expect(button(document.body, "Archive").dataset.variant).not.toBe("danger");
  });

  it("archives without force, with the delete choice, under a command id", async () => {
    const { bed } = await open({ ok: true, branchDeleted: true });
    await click(box("Delete branch"));
    await click(button(document.body, "Archive"));
    await settle();
    const call = bed.called("lanes.archive")[0];
    expect(call?.params).toEqual({ laneId: "a-1a2b", force: false, deleteBranch: true });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("Force names what it loses and turns Archive into danger", async () => {
    await open();
    await click(box("Force"));
    expect(body()).toContain("uncommitted changes and untracked files in the worktree");
    expect(button(document.body, "Archive").dataset.variant).toBe("danger");
    await click(box("Force"));
    expect(button(document.body, "Archive").dataset.variant).not.toBe("danger");
  });

  it("the force path asks first: nothing is sent until the loss is confirmed", async () => {
    const { bed } = await open();
    await click(box("Force"));
    await click(button(document.body, "Archive"));
    expect(bed.called("lanes.archive")).toHaveLength(0);
    expect(body()).toContain("Archive and lose the uncommitted changes and untracked files");
    await click(button(document.body, "Back"));
    expect(bed.called("lanes.archive")).toHaveLength(0);
    await click(button(document.body, "Archive"));
    afterGuard();
    await click(button(document.body, "Archive and discard"));
    await settle();
    expect(bed.called("lanes.archive")[0]?.params).toEqual({
      laneId: "a-1a2b",
      force: true,
      deleteBranch: false,
    });
  });

  it.each([
    ["busy", "A session, a script or a terminal of this lane is running"],
    ["dirty", "Uncommitted changes would be lost: commit them, or check Force"],
    ["setup_running", "Setup is running"],
  ])("explains a %s refusal", async (reason, words) => {
    const { bed } = await open({ ok: false, reason, logTail: null });
    await click(button(document.body, "Archive"));
    await settle();
    expect(body()).toContain(words);
    expect(bed.called("lanes.archive")).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it("shows the last lines of a failed archive script as plain text", async () => {
    await open({ ok: false, reason: "script_failed", logTail: "rm: boom\n<b>not bold</b>" });
    await click(button(document.body, "Archive"));
    await settle();
    expect(body()).toContain("The archive script failed:");
    expect(document.querySelector("pre")?.textContent).toBe("rm: boom\n<b>not bold</b>");
    expect(document.querySelector("pre b")).toBeNull();
  });

  it("a tainted answer asks inline, then archives again with confirmTainted", async () => {
    const { bed } = await open({ ok: false, reason: "tainted", logTail: null });
    await click(button(document.body, "Archive"));
    await settle();
    expect(body()).toContain("which an agent that read external content may have changed");
    expect(bed.called("lanes.archive")).toHaveLength(1);
    bed.handlers["lanes.archive"] = () => ({ ok: true, branchDeleted: null });
    await click(button(document.body, "Run anyway"));
    await settle();
    expect(bed.called("lanes.archive")[1]?.params).toEqual({
      laneId: "a-1a2b",
      force: false,
      deleteBranch: false,
      confirmTainted: true,
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("cancelling the tainted question sends nothing more", async () => {
    const { bed } = await open({ ok: false, reason: "tainted", logTail: null });
    await click(button(document.body, "Archive"));
    await settle();
    await click(button(document.querySelector('[role="status"]') as Element, "Cancel"));
    expect(bed.called("lanes.archive")).toHaveLength(1);
    expect(body()).not.toContain("which an agent that read external content");
  });

  it("says when git kept the branch, and does not close silently", async () => {
    const { bed } = await open({ ok: true, branchDeleted: false });
    await click(box("Delete branch"));
    await click(button(document.body, "Archive"));
    await settle();
    expect(bed.called("lanes.archive")).toHaveLength(1);
    expect(body()).toContain("Branch pi/a kept: it has commits that are neither merged nor pushed");
    expect(closed).not.toHaveBeenCalled();
    await click(button(document.body, "Done"));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("the Force and Delete branch copy says what each one reaches, in both languages", () => {
    expect(translate("en", "lanes.archive.forceLoses")).toBe(
      "Force discards the uncommitted changes and untracked files in the worktree. It does not touch the branch.",
    );
    expect(translate("en", "lanes.archive.deleteBranch.note")).toBe(
      "The branch goes only when its commits are merged or pushed.",
    );
    expect(translate("fr", "lanes.archive.branchKept", { branch: "pi/a" })).toBe(
      "Branche pi/a conservée : elle a des commits ni fusionnés ni poussés",
    );
    expect(translate("fr", "lanes.archive.deleteBranch.note")).toContain("fusionnés ou poussés");
  });

  it("maps a token's forbidden call to a clear message", async () => {
    const { bed } = await open();
    bed.handlers["lanes.archive"] = () => {
      throw new RpcError("forbidden");
    };
    await click(button(document.body, "Archive"));
    await settle();
    expect(body()).toContain("You do not have permission for this action.");
    expect(closed).not.toHaveBeenCalled();
  });

  it("Escape closes it, and focus returns to what had it", async () => {
    const { trigger } = await open();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await press(document.querySelector('[role="dialog"]') as Element, { key: "Escape" });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(hasButton(document.body, "Archive")).toBe(true);
    expect(trigger.isConnected).toBe(true);
  });

  it("a double-click or a held key on Archive with Force never confirms the loss", async () => {
    const { bed } = await open();
    await click(box("Force"));
    const archive = button(document.body, "Archive");
    await click(archive);
    await click(archive);
    await click(button(document.body, "Archive and discard"));
    await settle();
    expect(bed.called("lanes.archive")).toHaveLength(0);
    afterGuard();
    await click(button(document.body, "Archive and discard"));
    await settle();
    expect(bed.called("lanes.archive")).toHaveLength(1);
  });

  it("the options are locked while the tainted question is open, so Force cannot be added to it", async () => {
    const { bed } = await open({ ok: false, reason: "tainted", logTail: null });
    await click(button(document.body, "Archive"));
    await settle();
    expect(box("Force").hasAttribute("disabled")).toBe(true);
    expect(box("Delete branch").hasAttribute("disabled")).toBe(true);
    await click(box("Force"));
    bed.handlers["lanes.archive"] = () => ({ ok: true, branchDeleted: null });
    await click(button(document.body, "Run anyway"));
    await settle();
    expect(bed.called("lanes.archive")[1]?.params).toEqual({
      laneId: "a-1a2b",
      force: false,
      deleteBranch: false,
      confirmTainted: true,
    });
  });
});

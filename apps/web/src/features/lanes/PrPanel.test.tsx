// @vitest-environment happy-dom
import type { LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { current, inShell, newBed } from "./lanes-bed.tsx";
import { PrPanel } from "./PrPanel.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const prView = (patch: object = {}) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: false,
  conflicts: false,
  checks: { total: 4, passed: 2, failed: 1, pending: 1 },
  checkedAt: 1,
  error: null,
  ...patch,
});

async function show(patch: Partial<LaneView> = {}) {
  useLaneStore
    .getState()
    .apply(laneSnapshot([laneView({ id: "a-1a2b", title: "Fix the login", forge: "github", ...patch })]));
  const bed = newBed();
  const page = await mount(inShell(<PrPanel laneId="a-1a2b" />));
  await settle();
  return { bed, box: page.container };
}

let opened: ReturnType<typeof vi.fn>;
beforeEach(() => {
  useLaneStore.getState().reset();
  opened = vi.fn();
  vi.stubGlobal("open", opened);
});
afterEach(() => vi.unstubAllGlobals());

describe("pull request panel: without a PR", () => {
  it("offers a form with the lane's title, an empty body and a Draft box", async () => {
    const { box } = await show();
    expect(field(box, "Pull request title").value).toBe("Fix the login");
    expect((field(box, "Description") as HTMLTextAreaElement).value).toBe("");
    expect(box.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(hasButton(box, "Create PR")).toBe(true);
  });

  it("tells the owner a token wrote the description that is shown under the empty body", async () => {
    const own = await show();
    expect(text(own.box)).toContain("Empty: the lane's description is used");
    expect(text(own.box)).not.toContain("A token wrote");
    document.body.replaceChildren();
    useLaneStore.getState().reset();
    const { box } = await show({ createdBy: "token", descriptionPreview: "do the thing" });
    expect(text(box)).toContain("A token wrote this description: read it before you create the PR");
    expect(text(box)).not.toContain("is not shown here");
  });

  it("shows the lane's description under the empty body and hides it once the owner types", async () => {
    const { box } = await show({ descriptionPreview: "Close ticket 412\nand more" });
    const preview = () => box.querySelector('[data-slot="lane-pr-body-preview"]');
    expect(preview()?.textContent).toBe("Close ticket 412\nand more");
    await typeInto(field(box, "Description"), "my own words");
    expect(preview()).toBeNull();
    await typeInto(field(box, "Description"), "");
    expect(preview()?.textContent).toBe("Close ticket 412\nand more");
  });

  it("shows no preview block for a lane with no description", async () => {
    const { box } = await show();
    expect(box.querySelector('[data-slot="lane-pr-body-preview"]')).toBeNull();
  });

  it("writes hidden characters of a token's description as escapes", async () => {
    const { box } = await show({
      createdBy: "token",
      descriptionPreview: "ok\u202Eevil\u200Bzero\u00A0blank",
    });
    const shown = box.querySelector('[data-slot="lane-pr-body-preview"]')?.textContent ?? "";
    expect(shown).toBe("ok\\u202Eevil\\u200Bzero\\u00A0blank");
    expect(shown).not.toMatch(/[\u202E\u200B\u00A0]/);
  });

  it("says the preview is clipped only when the description is truncated", async () => {
    const note = "first 2000 characters shown; the full description is sent";
    const clipped = await show({ descriptionPreview: "x".repeat(2000), descriptionTruncated: true });
    expect(text(clipped.box)).toContain(note);
    document.body.replaceChildren();
    useLaneStore.getState().reset();
    const whole = await show({ descriptionPreview: "short" });
    expect(text(whole.box)).not.toContain(note);
  });

  it("creates the PR with what the form holds, under a command id", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => ({ ok: true, pr: prView() });
    await typeInto(field(box, "Pull request title"), "Fix login");
    await typeInto(field(box, "Description"), "Body text");
    await click(box.querySelector('[role="checkbox"]') as HTMLElement);
    await click(button(box, "Create PR"));
    await settle();
    const call = bed.called("lanes.prCreate")[0];
    expect(call?.params).toEqual({ laneId: "a-1a2b", title: "Fix login", body: "Body text", draft: true });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(text(box)).toContain("#7");
    expect(hasButton(box, "Create PR")).toBe(false);
  });

  it("does not create without a title", async () => {
    const { box } = await show();
    await typeInto(field(box, "Pull request title"), "  ");
    expect(button(box, "Create PR").disabled).toBe(true);
  });

  it("not_pushed offers Push and create, which pushes and then creates, in that order", async () => {
    const { bed, box } = await show();
    const order: string[] = [];
    let created = 0;
    bed.handlers["lanes.prCreate"] = () => {
      order.push("prCreate");
      created += 1;
      return created === 1 ? { ok: false, reason: "not_pushed" } : { ok: true, pr: prView() };
    };
    bed.handlers["lanes.push"] = () => {
      order.push("push");
      return { ok: true, remote: { host: "github.com", path: "o/r" } };
    };
    await click(button(box, "Create PR"));
    await settle();
    expect(text(box)).toContain("The branch is not on the remote yet.");
    expect(hasButton(box, "Create PR")).toBe(false);
    await click(button(box, "Push and create"));
    await settle();
    expect(order).toEqual(["prCreate", "push", "prCreate"]);
    expect(text(box)).toContain("#7");
  });

  it("stops at a refused push and says why, without creating", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => ({ ok: false, reason: "not_pushed" });
    bed.handlers["lanes.push"] = () => ({ ok: false, reason: "rejected" });
    await click(button(box, "Create PR"));
    await settle();
    await click(button(box, "Push and create"));
    await settle();
    expect(bed.called("lanes.prCreate")).toHaveLength(1);
    expect(alerts(box)[0]).toContain("The remote has commits this lane does not have");
  });

  it.each([
    ["forge_missing", "The forge's command-line tool is not installed on this machine."],
    ["not_signed_in", "The forge's command-line tool is not signed in."],
    ["unsupported_remote", "pap cannot open a pull request on this remote."],
    ["failed", "The pull request could not be created"],
  ])("answers %s in words", async (reason, words) => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => ({ ok: false, reason });
    await click(button(box, "Create PR"));
    await settle();
    expect(alerts(box)[0]).toContain(words);
  });

  it("says what to do when gh is missing or signed out", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => ({ ok: false, reason: "not_signed_in" });
    await click(button(box, "Create PR"));
    await settle();
    expect(text(box)).toContain("Run `gh auth login` in a terminal");
  });

  it("says GitLab and Gitea are not supported yet, and offers no Create", async () => {
    const { box } = await show({ forge: "gitlab" });
    expect(text(box)).toContain("GitLab and Gitea are not supported yet");
    expect(hasButton(box, "Create PR")).toBe(false);
  });

  it("after a timeout offers a check, not a second create", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => {
      throw new RpcError("timeout");
    };
    await click(button(box, "Create PR"));
    await settle();
    expect(text(box)).toContain("The pull request may exist");
    expect(hasButton(box, "Create PR")).toBe(false);
    bed.handlers["lanes.prRefresh"] = () => ({ pr: prView() });
    await click(button(box, "Check for the pull request"));
    await settle();
    expect(bed.called("lanes.prRefresh")[0]?.params).toEqual({ laneId: "a-1a2b" });
    expect(bed.called("lanes.prCreate")).toHaveLength(1);
    expect(text(box)).toContain("#7");
  });

  it("after a timeout and a check that finds nothing, creating is possible again", async () => {
    const { bed, box } = await show();
    bed.handlers["lanes.prCreate"] = () => {
      throw new RpcError("timeout");
    };
    await click(button(box, "Create PR"));
    await settle();
    bed.handlers["lanes.prRefresh"] = () => ({ pr: null });
    await click(button(box, "Check for the pull request"));
    await settle();
    expect(text(box)).toContain("No pull request was found for this branch.");
    expect(hasButton(box, "Create PR")).toBe(true);
  });
});

describe("pull request panel: with a PR", () => {
  it("shows the state, the checks and the conflicts", async () => {
    const { box } = await show({ pr: prView({ conflicts: true }) as LaneView["pr"] });
    const content = text(box);
    expect(content).toContain("#7");
    expect(content).toContain("open");
    expect(content).toContain("✓ 2");
    expect(content).toContain("✗ 1");
    expect(content).toContain("… 1");
    expect(content).toContain("conflicts");
  });

  it("marks a draft", async () => {
    const { box } = await show({ pr: prView({ draft: true }) as LaneView["pr"] });
    expect(text(box)).toContain("draft");
  });

  it("Refresh asks the forge again", async () => {
    const { bed, box } = await show({ pr: prView() as LaneView["pr"] });
    bed.handlers["lanes.prRefresh"] = () => ({ pr: prView({ state: "merged" }) });
    await click(button(box, "Refresh"));
    await settle();
    expect(bed.called("lanes.prRefresh")[0]?.params).toEqual({ laneId: "a-1a2b" });
  });

  it("shows the error word with a Retry that calls prRefresh", async () => {
    const { bed, box } = await show({ pr: prView({ error: "not_signed_in" }) as LaneView["pr"] });
    expect(text(box)).toContain("not signed in");
    expect(text(box)).toContain("Run `gh auth login` in a terminal");
    bed.handlers["lanes.prRefresh"] = () => ({ pr: prView() });
    await click(button(box, "Retry"));
    await settle();
    expect(bed.called("lanes.prRefresh")).toHaveLength(1);
  });

  it("opens an https address in a new tab with no opener", async () => {
    const { box } = await show({ pr: prView() as LaneView["pr"] });
    await click(button(box, "Open on GitHub"));
    expect(opened).toHaveBeenCalledWith("https://github.com/o/r/pull/7", "_blank", "noopener,noreferrer");
  });

  it("refuses a javascript: address", async () => {
    const { box } = await show({ pr: prView({ url: "javascript:alert(1)" }) as LaneView["pr"] });
    const open = button(box, "Open on GitHub");
    expect(open.disabled).toBe(true);
    await click(open);
    expect(opened).not.toHaveBeenCalled();
  });
});

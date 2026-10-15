// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { CheckpointBanner } from "./CheckpointBanner.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const status = (patch = {}) => ({
  target: { entryId: "e1", turn: 2 },
  exact: true,
  differs: true,
  undoAvailable: false,
  ...patch,
});
const seed = (patch: object) =>
  useSessionStore.setState({
    views: { "sess-1": { ...EMPTY_VIEW, loaded: true, status: "idle", leafId: "leaf-1", ...patch } },
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useSessionStore.setState({ views: {} });
});
afterEach(() => vi.useRealTimers());

async function open(answer: object = status()) {
  const bed = newBed();
  bed.handlers["lanes.checkpointStatus"] = () => answer;
  const page = await mount(inShell(<CheckpointBanner laneId="a-1a2b" sessionId="sess-1" />));
  await settle();
  return { bed, page };
}

describe("checkpoint banner: when it asks", () => {
  it("asks while the session is idle, once", async () => {
    seed({});
    const { bed } = await open();
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(1);
    expect(bed.called("lanes.checkpointStatus")[0]?.params).toEqual({
      laneId: "a-1a2b",
      sessionId: "sess-1",
    });
  });

  it("asks nothing while the session runs, even when the leaf changes", async () => {
    seed({ status: "running" });
    const { bed } = await open();
    await act(async () => seed({ status: "running", leafId: "leaf-2" }));
    await settle();
    await act(async () => seed({ status: "running", leafId: "leaf-3" }));
    await settle();
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(0);
  });

  it("keeps its last answer through a run, then asks again once idle on a new leaf", async () => {
    seed({});
    const { bed, page } = await open();
    expect(text(page.container)).toContain("Files differ from this point");
    await act(async () => seed({ status: "running", leafId: "leaf-2" }));
    await settle();
    expect(text(page.container)).toContain("Files differ from this point");
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(1500);
      seed({ status: "idle", leafId: "leaf-2" });
    });
    await settle();
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(2);
  });

  it("asks on focus while idle, at most once a second", async () => {
    seed({});
    const { bed } = await open();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(1100);
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(bed.called("lanes.checkpointStatus")).toHaveLength(2);
  });
});

describe("checkpoint banner: what it shows", () => {
  it("shows nothing when the files do not differ", async () => {
    seed({});
    const { page } = await open(status({ differs: false }));
    expect(text(page.container)).toBe("");
  });

  it("asks inline, without a count, before it restores", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => ({ ok: true, changed: true });
    await click(button(page.container, "Restore files"));
    expect(text(page.container)).toContain(
      "Restore the files to this point? Undo stays possible until the next restore.",
    );
    expect(text(page.container)).not.toMatch(/\d+ files?/);
    expect(bed.called("lanes.restore")).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(button(page.container, "Restore"));
    await settle();
    expect(bed.called("lanes.restore")[0]?.params).toEqual({ laneId: "a-1a2b", sessionId: "sess-1" });
  });

  it("cancelling the question restores nothing", async () => {
    seed({});
    const { bed, page } = await open();
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Cancel"));
    expect(bed.called("lanes.restore")).toHaveLength(0);
    expect(hasButton(page.container, "Restore files")).toBe(true);
  });

  it("offers Undo after a restore, and Undo asks the daemon to undo", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => ({ ok: true, changed: true });
    await click(button(page.container, "Restore files"));
    bed.handlers["lanes.checkpointStatus"] = () => status({ differs: false, undoAvailable: true });
    await click(button(page.container, "Restore"));
    await settle();
    expect(text(page.container)).toContain("The files were restored to this point");
    await click(button(page.container, "Undo"));
    await settle();
    expect(bed.called("lanes.restore")[1]?.params).toEqual({ laneId: "a-1a2b", undo: true });
  });

  it("shows Undo next to Restore files when an undo is available", async () => {
    seed({});
    const { page } = await open(status({ undoAvailable: true }));
    expect(hasButton(page.container, "Undo")).toBe(true);
    expect(hasButton(page.container, "Restore files")).toBe(true);
  });

  it("names what the restore left in place: the count, at most five paths, escaped", async () => {
    seed({});
    const { bed, page } = await open();
    const left = ["a", "b\u202Ec", "c", "d", "e", "f"].map((path) => ({ path, reason: "ignored" as const }));
    bed.handlers["lanes.restore"] = () => ({ ok: true, changed: true, left, leftTotal: 7 });
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Restore"));
    await settle();
    const shown = text(page.container);
    expect(shown).toContain("Restored, except 7 files left as they were:");
    expect(shown).not.toContain("The files were restored to this point");
    const items = [...page.container.querySelectorAll('[data-slot="restore-left"] li')].map(
      (node) => node.textContent,
    );
    expect(items).toEqual(["a", "b\\u202Ec", "c", "d", "e", "…"]);
  });

  it("keeps the plain message when the restore left nothing", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => ({ ok: true, changed: true, left: [] });
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Restore"));
    await settle();
    expect(text(page.container)).toContain("The files were restored to this point");
    expect(page.container.querySelector('[data-slot="restore-left"]')).toBeNull();
  });

  it("says the files already match when nothing changed", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => ({ ok: true, changed: false });
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Restore"));
    await settle();
    expect(text(page.container)).toContain("The files already match this point");
  });

  it("says to stop the agent or the script first when busy", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => ({ ok: false, reason: "busy" });
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Restore"));
    await settle();
    expect(text(page.container)).toContain("Stop the agent or the script first");
  });

  it("shows a refused call in words", async () => {
    seed({});
    const { bed, page } = await open();
    bed.handlers["lanes.restore"] = () => {
      throw new RpcError("forbidden");
    };
    await click(button(page.container, "Restore files"));
    await click(button(page.container, "Restore"));
    await settle();
    expect(text(page.container)).toContain("You do not have permission for this action.");
  });
});

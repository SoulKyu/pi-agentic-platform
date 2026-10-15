// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLaneStore } from "../../stores/lane-store.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fanoutView, laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { useComparePick } from "./compare-pick.ts";
import { CompareScreen } from "./CompareScreen.tsx";
import { current, inShell, newBed } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FAN = "f".repeat(16);
const A = "a-1a2b";
const B = "b-1a2b";
const column = (laneId: string, patch: object = {}) => ({
  laneId,
  summary: null,
  files: null,
  additions: null,
  deletions: null,
  durationMs: null,
  costUsd: null,
  ...patch,
});

let clock = 0;
const open = vi.fn();
const again = vi.fn();
const body = () => text(document.body);
const mark = (name: string, index: number): HTMLButtonElement => {
  const found = document.querySelectorAll<HTMLButtonElement>(`button[data-${name}]`)[index];
  if (found === undefined) throw new Error(`no ${name} button #${index}`);
  return found;
};
const theDialog = (): Element => {
  const found = document.querySelector('[role="dialog"]');
  if (found === null) throw new Error("no dialog");
  return found;
};

function seed(lanes = [laneView({ id: A, fanoutSlot: 0 }), laneView({ id: B, fanoutSlot: 1 })]) {
  useLaneStore
    .getState()
    .apply(
      laneSnapshot(lanes, [
        fanoutView({ id: FAN, prompt: "Replace the cache", laneIds: lanes.map((lane) => lane.id) }),
      ]),
    );
}

async function show(
  columns: object[] = [
    column(A, {
      summary: "Wraps the LRU.",
      durationMs: 400_000,
      costUsd: 0.38,
      files: 4,
      additions: 142,
      deletions: 61,
    }),
    column(B),
  ],
) {
  const bed = newBed();
  bed.handlers["lanes.compare"] = () => ({ columns });
  await mount(
    inShell(<CompareScreen fanoutId={FAN} onOpenLane={open} onRunAgain={again} now={() => clock} />),
  );
  await settle();
  return bed;
}

beforeEach(() => {
  clock = 100_000;
  open.mockReset();
  again.mockReset();
  seed();
});
afterEach(() => {
  useLaneStore.getState().reset();
  useComparePick.getState().clear(FAN);
});

describe("compare screen", () => {
  it("shows the prompt, one column per lane with its figures, and no verdict", async () => {
    await show();
    expect(body()).toContain("Replace the cache");
    expect(body()).toContain("+142 −61");
    expect(body()).toContain("6m40");
    expect(body()).toContain("$0.38");
    expect(body()).toContain("Wraps the LRU.");
    expect(body()).toContain("no tests");
    expect(body()).toContain("running");
    expect(body()).toContain("cost comes with M10");
    expect(body().toLowerCase()).not.toMatch(/\bbest\b|\brank|recommended/);
  });

  it("writes hidden characters of an untrusted summary as escapes", async () => {
    await show([column(A, { summary: "ok‮hidden​here" })]);
    expect(body()).toContain("ok\\u202Ehidden\\u200Bhere");
    expect(body()).not.toContain("‮");
  });

  it("keeps Close losers disabled until a winner is picked, then marks it and opens its lane", async () => {
    await show();
    expect(button(document.body, "Close losers").disabled).toBe(true);
    await click(mark("pick", 1));
    expect(open).toHaveBeenCalledWith(B);
    expect(button(document.body, "Close losers").disabled).toBe(false);
    expect(document.querySelector(`[data-lane="${B}"]`)?.getAttribute("data-winner")).toBe("true");
    expect(document.querySelector(`[data-lane="${A}"]`)?.getAttribute("data-winner")).toBe("false");
  });

  it("opens the lane tab from View diff without picking", async () => {
    await show();
    await click(mark("view", 0));
    expect(open).toHaveBeenCalledWith(A);
    expect(button(document.body, "Close losers").disabled).toBe(true);
  });

  it("offers Run tests for a lane nothing ran on, and sends a test run", async () => {
    const bed = await show();
    bed.handlers["lanes.runScript"] = () => ({ ok: true });
    await click(mark("run-tests", 0));
    expect(bed.called("lanes.runScript")[0]?.params).toEqual({ laneId: A, kind: "test" });
  });

  it("asks inline when the run is tainted and sends again with the confirmation", async () => {
    const bed = await show();
    const answers = [{ ok: false, reason: "tainted" }, { ok: true }];
    bed.handlers["lanes.runScript"] = () => answers.shift();
    await click(mark("run-tests", 0));
    await settle();
    expect(body()).toContain("Run anyway");
    await click(button(document.body, "Run anyway"));
    await settle();
    expect(bed.called("lanes.runScript")[1]?.params).toEqual({
      laneId: A,
      kind: "test",
      confirmTainted: true,
    });
    expect(body()).not.toContain("Run anyway");
  });

  it("opens the new lane dialog again with the prompt and the models", async () => {
    await show();
    await click(button(document.body, "Run again"));
    expect(again).toHaveBeenCalledWith({
      projectRoot: "/w/proj",
      text: "Replace the cache",
      models: [null, null],
    });
  });

  it("says why the comparison could not be read and tries again", async () => {
    const bed = newBed();
    let fail = true;
    bed.handlers["lanes.compare"] = () => {
      if (fail) throw new RpcError("timeout");
      return { columns: [column(A)] };
    };
    await mount(
      inShell(<CompareScreen fanoutId={FAN} onOpenLane={open} onRunAgain={again} now={() => clock} />),
    );
    await settle();
    expect(body()).toContain("took too long");
    fail = false;
    await click(button(document.body, "Try again"));
    await settle();
    expect(body()).not.toContain("took too long");
    expect(hasButton(document.body, "Run again")).toBe(true);
  });

  it("says the group is gone when the store does not know it", async () => {
    useLaneStore.getState().reset();
    useLaneStore.getState().apply(laneSnapshot([], []));
    newBed();
    await mount(
      inShell(<CompareScreen fanoutId={FAN} onOpenLane={open} onRunAgain={again} now={() => clock} />),
    );
    await settle();
    expect(body()).toContain("no longer here");
  });
});

describe("close losers: the hint link (M9 sweep, item 13)", () => {
  it("points at the hint only while no winner is picked", async () => {
    await show();
    const close = button(document.body, "Close losers");
    expect(close.getAttribute("aria-describedby")).toBe("compare-close-hint");
    expect(document.getElementById("compare-close-hint")).not.toBeNull();
    await click(mark("pick", 0));
    expect(button(document.body, "Close losers").hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById("compare-close-hint")).toBeNull();
  });
});

describe("close losers", () => {
  async function pickA(bed: Awaited<ReturnType<typeof show>>) {
    void bed;
    await click(mark("pick", 0));
    await click(button(document.body, "Close losers"));
    await settle();
  }

  it("names each other lane and what goes before anything is sent", async () => {
    const bed = await show();
    await pickA(bed);
    const dialog = theDialog();
    expect(text(dialog)).toContain("pi/b-1a2b");
    expect(text(dialog)).toContain("uncommitted changes");
    expect(text(dialog)).toContain("the branch and its commits stay");
    expect(text(dialog)).not.toContain("pi/a-1a2b:");
    expect(bed.called("lanes.closeLosers")).toHaveLength(0);
  });

  it("says which losers lose changed files, how many, and which have nothing uncommitted", async () => {
    const facts = (dirty: number) => ({
      dirty,
      ahead: 0,
      behind: 0,
      unpushed: null,
      additions: 0,
      deletions: 0,
      checkedAt: 1,
      error: null,
    });
    const C = "c-1a2b";
    const D = "d-1a2b";
    seed([
      laneView({ id: A, fanoutSlot: 0 }),
      laneView({ id: B, fanoutSlot: 1, facts: facts(3) }),
      laneView({ id: C, fanoutSlot: 2, facts: facts(0) }),
      laneView({ id: D, fanoutSlot: 3, facts: facts(1) }),
    ]);
    const bed = await show([column(A)]);
    await pickA(bed);
    const lines = [...theDialog().querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual([
      "B · pi/b-1a2b: 3 changed files go; the branch and its commits stay.",
      "C · pi/c-1a2b: nothing uncommitted; the branch and its commits stay.",
      "D · pi/d-1a2b: 1 changed file goes; the branch and its commits stay.",
    ]);
  });

  it("ignores a press within the guard, then sends the winner", async () => {
    const bed = await show();
    bed.handlers["lanes.closeLosers"] = () => ({ archived: [B], refused: [] });
    await pickA(bed);
    await click(button(theDialog(), "Close 1 lane"));
    expect(bed.called("lanes.closeLosers")).toHaveLength(0);
    clock += 600;
    await click(button(theDialog(), "Close 1 lane"));
    await settle();
    expect(bed.called("lanes.closeLosers")[0]?.params).toEqual({ fanoutId: FAN, winner: A });
    expect(bed.called("lanes.closeLosers")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("lists refusals and asks inline for a tainted lane, then sends again with the confirmation", async () => {
    const bed = await show([column(A), column(B)]);
    const answers = [
      { archived: [], refused: [{ laneId: B, reason: "tainted" }] },
      { archived: [B], refused: [] },
    ];
    bed.handlers["lanes.closeLosers"] = () => answers.shift();
    await pickA(bed);
    clock += 600;
    await click(button(theDialog(), "Close 1 lane"));
    await settle();
    expect(text(document.body)).toContain("Run anyway");
    await click(button(document.body, "Run anyway"));
    await settle();
    expect(bed.called("lanes.closeLosers")[1]?.params).toEqual({
      fanoutId: FAN,
      winner: A,
      confirmTainted: true,
    });
  });

  it("lists a lane that stays because something is running", async () => {
    const bed = await show();
    bed.handlers["lanes.closeLosers"] = () => ({
      archived: [],
      refused: [{ laneId: B, reason: "busy" }],
    });
    await pickA(bed);
    clock += 600;
    await click(button(theDialog(), "Close 1 lane"));
    await settle();
    const dialog = theDialog();
    expect(text(dialog)).toContain("pi/b-1a2b");
    expect(text(dialog)).toContain("still running");
    expect(hasButton(dialog, "Done")).toBe(true);
  });

  it("maps a refused call to a clear message", async () => {
    const bed = await show();
    bed.handlers["lanes.closeLosers"] = () => {
      throw new RpcError("bad_request");
    };
    await pickA(bed);
    clock += 600;
    await click(button(theDialog(), "Close 1 lane"));
    await settle();
    expect(text(theDialog())).toContain("not a lane of this group");
  });
});

// @vitest-environment happy-dom
import type { LaneView } from "@pap/contracts";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { type ArchivedLanes, useArchivedLanes } from "./use-archived-lanes.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const seen: { value?: ArchivedLanes } = {};
const latest = (): ArchivedLanes => {
  if (seen.value === undefined) throw new Error("the probe has not rendered");
  return seen.value;
};
const Probe = () => {
  const hook = useArchivedLanes();
  useEffect(() => {
    seen.value = hook;
  });
  return null;
};
const page = (...lanes: LaneView[]) => ({ lanes, hasMore: false });
const pending = () => {
  const waiting: Array<(value: unknown) => void> = [];
  bed.handlers["lanes.listArchived"] = () => new Promise((resolve) => waiting.push(resolve));
  return waiting;
};

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
});

describe("useArchivedLanes", () => {
  it("keeps the newest answer when an older call answers last", async () => {
    const waiting = pending();
    await mount(<Probe />);
    await act(async () => latest().retry());
    expect(waiting).toHaveLength(2);
    await act(async () => waiting[1]?.(page(laneView({ id: "new-1a2b", state: "archived" }))));
    await act(async () => waiting[0]?.(page(laneView({ id: "old-1a2b", state: "archived" }))));
    expect(latest().lanes.map((lane) => lane.id)).toEqual(["new-1a2b"]);
  });

  it("makes no state update and no warning for a page that answers after unmount", async () => {
    const waiting = pending();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mounted = await mount(<Probe />);
    await mounted.unmount();
    await act(async () => waiting[0]?.(page()));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not report a failure that answers after a newer call succeeded", async () => {
    const waiting: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
    bed.handlers["lanes.listArchived"] = () =>
      new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    await mount(<Probe />);
    await act(async () => latest().retry());
    await act(async () => waiting[1]?.resolve(page()));
    await act(async () => waiting[0]?.reject(new Error("old")));
    expect(latest().failed).toBe(false);
  });
});

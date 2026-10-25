// @vitest-environment happy-dom
import type { HelperStatus, LaunchView } from "@pap/contracts";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import {
  formatLaunchTime,
  launchOf,
  reduceLaunches,
  useHelperStatus,
  useLaunches,
  useLaunchOf,
  useLaunchStore,
} from "./launch-store.ts";

const PROJECT = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
const launch = (id: string, over: Partial<LaunchView> = {}): LaunchView => ({
  id,
  box: { kind: "project", id: PROJECT },
  for: "start",
  startedAt: 1,
  steps: [],
  ...over,
});
const helpers: HelperStatus = { active: 1, max: 4, waiting: 0 };
const EMPTY = { launches: new Map<string, LaunchView>(), helpers: { active: 0, max: 0, waiting: 0 } };

beforeEach(() => useLaunchStore.getState().reset());

describe("reduceLaunches", () => {
  it("a snapshot replaces the live launches", () => {
    const before = reduceLaunches(EMPTY, { kind: "launch", launch: launch("old") });
    const view = reduceLaunches(before, { kind: "snapshot", launches: [launch("a"), launch("b")], helpers });
    expect([...view.launches.keys()]).toEqual(["a", "b"]);
    expect(view.helpers).toEqual(helpers);
  });

  it("a launch event adds or replaces by id", () => {
    const first = reduceLaunches(EMPTY, { kind: "launch", launch: launch("a") });
    const next = reduceLaunches(first, { kind: "launch", launch: launch("a", { for: "s1" }) });
    expect(next.launches.size).toBe(1);
    expect(next.launches.get("a")?.for).toBe("s1");
  });

  it("an end event removes the launch", () => {
    const first = reduceLaunches(EMPTY, { kind: "launch", launch: launch("a") });
    const view = reduceLaunches(first, { kind: "end", id: "a", done: true, ok: true });
    expect(view.launches.size).toBe(0);
    expect(reduceLaunches(view, { kind: "end", id: "zzz", done: true, ok: false, code: "capacity" })).toBe(
      view,
    );
  });

  it("helpers events update the counts", () => {
    const view = reduceLaunches(EMPTY, { kind: "helpers", helpers: { active: 4, max: 4, waiting: 2 } });
    expect(view.helpers).toEqual({ active: 4, max: 4, waiting: 2 });
  });

  it("skips garbage, never fatal", () => {
    expect(reduceLaunches(EMPTY, { kind: "nope" })).toBe(EMPTY);
    expect(reduceLaunches(EMPTY, null)).toBe(EMPTY);
  });
});

describe("selectors", () => {
  it("useLaunchOf finds a launch by box", () => {
    useLaunchStore.getState().apply({ kind: "launch", launch: launch("a") });
    const { launches } = useLaunchStore.getState().view;
    expect(launchOf(launches, { kind: "project", id: PROJECT })?.id).toBe("a");
    expect(launchOf(launches, { kind: "agent", id: "atlas-1a2b" })).toBeUndefined();
    expect(launchOf(launches, null)).toBeUndefined();
    useLaunchStore.getState().apply({ kind: "end", id: "a", done: true, ok: true });
    expect(
      launchOf(useLaunchStore.getState().view.launches, { kind: "project", id: PROJECT }),
    ).toBeUndefined();
  });

  it("the store holds the live launches and the helper counts a reset clears", () => {
    useLaunchStore.getState().apply({ kind: "snapshot", launches: [launch("a")], helpers });
    expect([...useLaunchStore.getState().view.launches.keys()]).toEqual(["a"]);
    expect(useLaunchStore.getState().view.helpers).toEqual(helpers);
    useLaunchStore.getState().reset();
    expect(useLaunchStore.getState().view.launches.size).toBe(0);
  });
});

describe("hooks", () => {
  it("useLaunchOf, useLaunches and useHelperStatus follow the store", async () => {
    const Probe = () => {
      const one = useLaunchOf({ kind: "project", id: PROJECT });
      const all = useLaunches();
      const status = useHelperStatus();
      return createElement(
        "p",
        { "data-testid": "probe" },
        `${one?.id ?? "-"}|${all.length}|${status.active}`,
      );
    };
    const mounted = await mount(createElement(Probe));
    const text = () => mounted.container.querySelector("p")?.textContent;
    expect(text()).toBe("-|0|0");
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "snapshot", launches: [launch("a")], helpers });
    });
    expect(text()).toBe("a|1|1");
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: "a", done: true, ok: true });
    });
    expect(text()).toBe("-|0|1");
  });
});

describe("formatLaunchTime", () => {
  it("words a duration in s, min and h", () => {
    expect(formatLaunchTime(0)).toBe("0 s");
    expect(formatLaunchTime(999)).toBe("0 s");
    expect(formatLaunchTime(45_000)).toBe("45 s");
    expect(formatLaunchTime(60_000)).toBe("1 min");
    expect(formatLaunchTime(65_000)).toBe("1 min 5 s");
    expect(formatLaunchTime(30 * 60_000)).toBe("30 min");
    expect(formatLaunchTime(3_725_000)).toBe("1 h 2 min");
    expect(formatLaunchTime(-5)).toBe("0 s");
  });
});

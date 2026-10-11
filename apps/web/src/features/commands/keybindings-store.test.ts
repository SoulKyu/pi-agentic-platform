// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { parseRules, startKeybindings, syncKeybindings, useKeybindingsStore } from "./keybindings-store.ts";

const report = vi.hoisted(() => ({ reportClientIssue: vi.fn() }));
vi.mock("../../lib/report.ts", () => report);

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function server(get: Array<() => unknown>, set: Array<() => unknown> = []) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) throw new Error(`no scripted answer for ${method}`);
    return step();
  });
  return {
    rpc: { call } as never,
    sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params),
  };
}

let started: { stop(): void } | null = null;
beforeEach(() => {
  vi.useFakeTimers(); // the document's 400 ms debounce
  localStorage.clear();
  useKeybindingsStore.getState().setUser([]);
  report.reportClientIssue.mockClear();
});
afterEach(() => {
  started?.stop();
  started = null;
  vi.useRealTimers();
});

describe("keybindings store", () => {
  it("replaces the defaults of a command the user rebinds, and puts user rules last", () => {
    useKeybindingsStore.getState().setUser([{ key: "mod+shift+p", command: "palette.toggle" }]);
    const rules = useKeybindingsStore.getState().rules;
    expect(
      rules.filter((r) => r.command === "palette.toggle").map((r) => `${r.source}:${r.chord.key}`),
    ).toEqual(["user:p"]);
    expect(rules.at(-1)?.command).toBe("palette.toggle");
  });

  it("reports invalid entries once and keeps the valid ones", () => {
    useKeybindingsStore.getState().setUser([
      { key: "mod+banana", command: "palette.toggle" },
      { key: "alt+p", command: "palette.toggle" },
    ]);
    expect(useKeybindingsStore.getState().issues).toEqual([{ index: 0, problem: "key" }]);
    expect(report.reportClientIssue).toHaveBeenCalledExactlyOnceWith("keybindings_invalid");
  });

  it("reads a hand-edited local cache field by field (M3-RT-29)", () => {
    expect(
      parseRules([
        { key: "alt+p", command: "palette.toggle" },
        "nope",
        { key: 3 },
        { key: "mod+k", command: "rm -rf" },
      ]),
    ).toEqual([{ key: "alt+p", command: "palette.toggle" }]);
    expect(report.reportClientIssue).toHaveBeenCalledWith("keybindings_invalid");
    expect(
      parseRules(Array.from({ length: 300 }, () => ({ key: "mod+k", command: "palette.toggle" }))),
    ).toHaveLength(256);
    expect(parseRules({ not: "a list" })).toEqual([]);
  });

  it("takes the server's rules once connected", async () => {
    started = startKeybindings();
    await syncKeybindings(
      server([() => ({ value: [{ key: "alt+p", command: "palette.toggle" }], revision: 1 })]).rpc,
    );
    expect([useKeybindingsStore.getState().user, useKeybindingsStore.getState().status]).toEqual([
      [{ key: "alt+p", command: "palette.toggle" }],
      "saved",
    ]);
  });

  it("sends a change made before the load, from the server's revision", async () => {
    started = startKeybindings();
    useKeybindingsStore.getState().setUser([{ key: "alt+o", command: "palette.toggle" }]);
    await vi.advanceTimersByTimeAsync(400);
    const s = server(
      [() => ({ value: [{ key: "alt+q", command: "palette.toggle" }], revision: 3 })],
      [() => ({ revision: 4 })],
    );
    await syncKeybindings(s.rpc);
    await drain();
    expect(useKeybindingsStore.getState().user).toEqual([{ key: "alt+o", command: "palette.toggle" }]);
    expect(s.sets()).toEqual([
      { key: "keybindings", value: [{ key: "alt+o", command: "palette.toggle" }], baseRevision: 3 },
    ]);
  });

  it("keeps its own rules for an older daemon and never saves to it", async () => {
    started = startKeybindings();
    useKeybindingsStore.getState().setUser([{ key: "alt+o", command: "palette.toggle" }]);
    const s = server([() => Promise.reject(new RpcError("unknown_method"))]);
    await syncKeybindings(s.rpc);
    await vi.advanceTimersByTimeAsync(1000);
    expect([useKeybindingsStore.getState().user.length, s.sets()]).toEqual([1, []]);
  });
});

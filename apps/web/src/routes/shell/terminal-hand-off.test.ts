// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useTerminalTypists, type TerminalTypist } from "../../stores/terminal-typists.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useSurfaceView, useTerminalReady } from "./surface-view.ts";
import { toTerminal } from "./terminal-hand-off.ts";

const issues = vi.hoisted(() => ({ reported: [] as string[] }));
vi.mock("../../lib/report.ts", () => ({
  reportClientIssue: (code: string) => void issues.reported.push(code),
}));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const NEW_ID = terminalView(9).id;
let bed: ReturnType<typeof fakeRuntime>;

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        pending.set(next, { at: now + ms, fn });
        return next++;
      },
      clear: (id: number) => void pending.delete(id),
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const typist = (answers: Array<"typed" | "multiline" | "not_ready">) => {
  const handOff = vi.fn<TerminalTypist["handOff"]>(() => answers.shift() ?? "typed");
  return { handOff } satisfies TerminalTypist;
};
const flushAll = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const created = () => bed.calls.filter((call) => call.method === "terminal.create");

beforeEach(() => {
  issues.reported.length = 0;
  bed = fakeRuntime();
  bed.handlers["terminal.create"] = () => ({ terminalId: NEW_ID });
  current.runtime = bed.runtime;
  // loaded, then reset: clears what surface-terminal remembers of the last test
  useTerminalStore.getState().apply({ kind: "snapshot", terminals: [] });
  useTerminalStore.getState().reset();
  useTerminalStore.getState().apply({ kind: "snapshot", terminals: [] });
  useTerminalTypists.getState().reset();
  useShellStore.getState().reset();
  useTerminalReady.getState().set(true);
  useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
  useSurfaceView.getState().show("session:s1", "term");
  delete document.documentElement.dataset["shell"];
  useShellStore.getState().apply(
    shellSnapshot([shellSession({ id: "s1", cwd: "/w/p1", projectId: "p1" })], {
      projects: [shellProject({ id: "p1", root: "/w/p1" })],
    }),
  );
});
afterEach(() => {
  useTerminalStore.getState().reset();
  delete document.documentElement.dataset["shell"];
});

const TAB = "session:s1";

describe("toTerminal", () => {
  it("the session's tagged running terminal is reused, with no terminal.create", async () => {
    const { timers } = fakeTimers();
    const tagged = terminalView(1, { sessionId: "s1" });
    useTerminalStore.getState().apply({ kind: "snapshot", terminals: [tagged] });
    const one = typist(["typed"]);
    useTerminalTypists.getState().register(tagged.id, one);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("typed");
    expect(created()).toEqual([]);
    expect(one.handOff).toHaveBeenCalledExactlyOnceWith("ls");
    expect(useWorkspaceStore.getState().ws.tabs.find((tab) => tab.key === TAB)?.split?.item).toEqual({
      kind: "terminal",
      id: tagged.id,
    });
  });

  it("with none, one terminal.create for the session's cwd, then typed once", async () => {
    const { timers } = fakeTimers();
    const one = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, one);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("typed");
    expect(created()).toHaveLength(1);
    expect(created()[0]?.params).toMatchObject({ cwd: "/w/p1", sessionId: "s1" });
    expect(one.handOff).toHaveBeenCalledOnce();
  });

  it("a running terminal tagged with another session is never used", async () => {
    const { timers } = fakeTimers();
    const foreign = terminalView(1, { sessionId: "other" });
    const untagged = terminalView(2, { sessionId: null });
    useTerminalStore.getState().apply({ kind: "snapshot", terminals: [foreign, untagged] });
    const wrong = typist(["typed"]);
    useTerminalTypists.getState().register(foreign.id, wrong);
    useTerminalTypists.getState().register(untagged.id, wrong);
    const right = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, right);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("typed");
    expect(created()).toHaveLength(1);
    expect(wrong.handOff).not.toHaveBeenCalled();
    expect(right.handOff).toHaveBeenCalledOnce();
  });

  it("waits for the pane to mount and to be ready, then types once", async () => {
    const { timers, advance } = fakeTimers();
    const outcome = toTerminal(TAB, "s1", "ls", { timers });
    await flushAll();
    advance(300);
    const late = typist(["not_ready", "typed"]);
    useTerminalTypists.getState().register(NEW_ID, late);
    advance(500);
    await expect(outcome).resolves.toBe("typed");
    expect(late.handOff).toHaveBeenCalledTimes(2);
  });

  it("no typist within 10 s after the id is known: timeout, nothing typed", async () => {
    const { timers, advance } = fakeTimers();
    const other = typist(["typed"]);
    useTerminalTypists.getState().register("t-other", other);
    const outcome = toTerminal(TAB, "s1", "ls", { timers });
    await flushAll();
    advance(9_900);
    let settled = false;
    void outcome.then(() => (settled = true));
    await flushAll();
    expect(settled).toBe(false);
    advance(200);
    await expect(outcome).resolves.toBe("timeout");
    expect(other.handOff).not.toHaveBeenCalled();
  });

  it("a typist that never gets ready is a timeout, nothing typed", async () => {
    const { timers, advance } = fakeTimers();
    const stuck = typist(Array(200).fill("not_ready"));
    useTerminalTypists.getState().register(NEW_ID, stuck);
    const outcome = toTerminal(TAB, "s1", "ls", { timers });
    await flushAll();
    advance(10_500);
    await expect(outcome).resolves.toBe("timeout");
    expect(stuck.handOff.mock.results.every((r) => r.value === "not_ready")).toBe(true);
  });

  it("no terminal for the session: unavailable", async () => {
    const { timers } = fakeTimers();
    useTerminalReady.getState().set(false);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("unavailable");
    expect(created()).toEqual([]);
  });

  it("a refusal on a phone switches the tab back to Chat; on a desktop the view is left alone", async () => {
    const { timers } = fakeTimers();
    useTerminalTypists.getState().register(NEW_ID, typist(["multiline", "multiline"]));
    await expect(toTerminal(TAB, "s1", "a\nb", { timers })).resolves.toBe("multiline");
    expect(useSurfaceView.getState()).toMatchObject({ tabKey: TAB, view: "term" });
    document.documentElement.dataset["shell"] = "mobile";
    await expect(toTerminal(TAB, "s1", "a\nb", { timers })).resolves.toBe("multiline");
    expect(useSurfaceView.getState()).toMatchObject({ tabKey: TAB, view: "chat" });
  });

  it("a different text while one is in flight is busy and types nothing", async () => {
    const { timers } = fakeTimers();
    const one = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, one);
    const first = toTerminal(TAB, "s1", "touch a", { timers });
    const other = toTerminal(TAB, "s1", "touch b", { timers });
    await expect(other).resolves.toBe("busy");
    await expect(first).resolves.toBe("typed");
    expect(one.handOff).toHaveBeenCalledExactlyOnceWith("touch a");
  });

  it("two clicks share one hand-off", async () => {
    const { timers } = fakeTimers();
    const one = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, one);
    const first = toTerminal(TAB, "s1", "ls", { timers });
    const second = toTerminal(TAB, "s1", "ls", { timers });
    await expect(Promise.all([first, second])).resolves.toEqual(["typed", "typed"]);
    expect(one.handOff).toHaveBeenCalledOnce();
    expect(created()).toHaveLength(1);
    const again = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, again);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("typed");
    expect(again.handOff).toHaveBeenCalledOnce();
  });

  it("a throw inside a later attempt settles as unavailable, reports it and frees the session", async () => {
    const { timers, advance } = fakeTimers();
    let calls = 0;
    const breaking: TerminalTypist = {
      handOff: () => {
        if (++calls === 1) return "not_ready";
        throw new Error("screen disposed");
      },
    };
    useTerminalTypists.getState().register(NEW_ID, breaking);
    const outcome = toTerminal(TAB, "s1", "ls", { timers });
    await flushAll();
    advance(200);
    await expect(outcome).resolves.toBe("unavailable");
    expect(issues.reported).toEqual(["terminal_hand_off_failed"]);
    const again = typist(["typed"]);
    useTerminalTypists.getState().register(NEW_ID, again);
    await expect(toTerminal(TAB, "s1", "ls", { timers })).resolves.toBe("typed");
  });
});

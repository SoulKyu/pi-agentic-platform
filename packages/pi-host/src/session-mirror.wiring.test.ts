import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import { createEntryTracker } from "./entry-tracker.ts";
import type { Ipc } from "./ipc.ts";
import { closeSession } from "./shutdown.ts";
import type { UiBridge } from "./ui-bridge.ts";

// Where the mirror is called from (RT-38): after a walk, after a command response, on session_resync, before exit.

function dispatchBed(mirror?: { flush(): void; resync(request: unknown): void }) {
  const order: string[] = [];
  const dispatch = createDispatch({
    papHome: "/pap",
    applyTaint: () => {},
    session: { sessionId: "s", pendingMessageCount: 0 } as unknown as AgentSession,
    ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
    ui: {} as UiBridge,
    approvals: {} as Approvals,
    leafMayHaveMoved: () => {},
    setRules: () => {},
    ...(mirror ? { mirror: mirror as never } : {}),
  });
  return { order, dispatch };
}

describe("the mirror's flush points", () => {
  it("flushes after the response of a command, not before it", () => {
    const order: string[] = [];
    const mirror = { flush: () => void order.push("flush"), resync: () => {} };
    const dispatch = createDispatch({
      papHome: "/pap",
      applyTaint: () => {},
      session: { sessionId: "s", pendingMessageCount: 0 } as unknown as AgentSession,
      ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
      mirror,
    });
    dispatch({ type: "get_state", id: "g1" });
    expect(order).toEqual(["response", "flush"]);
  });

  it("hands session_resync to the mirror, and ignores it without one", () => {
    const requests: unknown[] = [];
    const { dispatch } = dispatchBed({ flush: () => {}, resync: (request) => void requests.push(request) });
    dispatch({ type: "session_resync", fromOffset: 12, lastEntryId: "e1" });
    expect(requests).toEqual([{ type: "session_resync", fromOffset: 12, lastEntryId: "e1" }]);
    const bare = dispatchBed();
    bare.dispatch({ type: "session_resync", fromOffset: 0, lastEntryId: null });
    bare.dispatch({ type: "get_state", id: "g2" });
    expect(bare.order).toEqual(["response"]);
  });

  it("calls afterWalk after every entry-tracker flush, an error included", () => {
    const calls: string[] = [];
    const deferred: Array<() => void> = [];
    let broken = false;
    const tracker = createEntryTracker({
      manager: {
        getLeafId: () => {
          if (broken) throw new Error("tree");
          return null;
        },
        getEntry: () => undefined,
      },
      send: () => {},
      defer: (task) => void deferred.push(task),
      onError: () => void calls.push("error"),
      afterWalk: () => void calls.push("walk"),
    });
    tracker.observe({ type: "message_end" });
    deferred.splice(0).forEach((task) => task());
    broken = true;
    tracker.observe({ type: "message_end" });
    deferred.splice(0).forEach((task) => task());
    expect(calls).toEqual(["walk", "error", "walk"]);
  });

  it("flushes the mirror once the session has shut down, and still when the shutdown steps fail", async () => {
    const order: string[] = [];
    const session = {
      abort: async () => {
        order.push("abort");
        throw new Error("stuck");
      },
      extensionRunner: { emit: async () => void order.push("session_shutdown") },
    } as unknown as AgentSession;
    await closeSession(
      session,
      100,
      undefined,
      () => {},
      () => void order.push("flush"),
    );
    expect(order).toEqual(["abort", "session_shutdown", "flush"]);
    const throwing = { ...session } as unknown as AgentSession;
    const lines: string[] = [];
    await closeSession(
      throwing,
      100,
      undefined,
      (line) => void lines.push(line),
      () => {
        throw new Error("disk");
      },
    );
    expect(lines.at(-1)).toBe("pi-host: session mirror flush failed during shutdown: disk\n");
  });
});

describe("a new VM session", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is created in the layout's sessions folder", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { sessionDirOf } = await import("./open-session.ts");
    root = realpathSync(mkdtempSync(join(tmpdir(), "pap-vmsess-")));
    const sessions = join(root, "agent", ".pi", "sessions");
    mkdirSync(sessions, { recursive: true });
    const manager = SessionManager.create(root, sessionDirOf({ vm: { layout: { sessions } } } as never));
    manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "yo" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const file = manager.getSessionFile() as string;
    expect(join(sessions, basename(file))).toBe(file);
    expect(sessionDirOf({} as never)).toBeUndefined();
  });
});

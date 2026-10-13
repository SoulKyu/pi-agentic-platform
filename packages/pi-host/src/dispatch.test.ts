import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { POLICY_EXTENSION_PATH, PolicyRules } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import { createTaint } from "./policy/taint.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

const withAlways = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [{ tool: "bash", key: "d".repeat(64) }],
});

describe("dispatch", () => {
  it("makes the rules null when a policy update is malformed, says so, and restores them on a valid one (M5R11)", () => {
    const sent: Array<Record<string, unknown>> = [];
    let rules: PolicyRules | null = withAlways;
    const dispatch = createDispatch({
      applyTaint: () => {},
      session: {} as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      setRules: (next) => {
        rules = next;
      },
    });
    dispatch({ type: "policy_update", rules: { profile: "interactive", approvalMode: "yolo" } });
    expect(rules).toBeNull();
    expect(sent).toEqual([
      {
        type: "extension_error",
        extensionPath: POLICY_EXTENSION_PATH,
        event: "policy_update",
        error: "invalid policy rules: every call is blocked until the next valid update",
      },
    ]);
    dispatch({ type: "policy_update", rules: withAlways });
    expect(rules).toEqual(withAlways);
    expect(sent).toHaveLength(1);
  });

  it("asks for a look at the leaf after navigate_tree has answered, in that order", async () => {
    const order: string[] = [];
    const session = {
      navigateTree: async () => ({ cancelled: false }),
      sessionManager: { getLeafId: () => "e7" },
    } as unknown as AgentSession;
    const dispatch = createDispatch({
      applyTaint: () => {},
      session,
      ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => void order.push("look"),
      setRules: () => {},
    });
    dispatch({ type: "navigate_tree", id: "n1", targetId: "e7" });
    await vi.waitFor(() => expect(order).toEqual(["response", "look"]));
  });

  it.each([
    ["set_session_name", { type: "set_session_name", id: "n1", name: "Fix" }],
    ["auto_name", { type: "auto_name", id: "n1" }],
  ] as const)(
    "asks for a look at the leaf after %s has answered (it appends an entry)",
    async (_name, command) => {
      const order: string[] = [];
      const session = {
        setSessionName: () => {},
        model: undefined,
      } as unknown as AgentSession;
      const dispatch = createDispatch({
        applyTaint: () => {},
        session,
        ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
        ui: {} as UiBridge,
        approvals: {} as Approvals,
        leafMayHaveMoved: () => void order.push("look"),
        setRules: () => {},
      });
      dispatch(command);
      await vi.waitFor(() => expect(order).toEqual(["response", "look"]));
    },
  );

  it("does not ask for a look when set_session_name failed", async () => {
    const order: string[] = [];
    const session = {
      setSessionName: () => {
        throw new Error("disk full");
      },
    } as unknown as AgentSession;
    const dispatch = createDispatch({
      applyTaint: () => {},
      session,
      ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => void order.push("look"),
      setRules: () => {},
    });
    dispatch({ type: "set_session_name", id: "n1", name: "Fix" });
    await Promise.resolve();
    expect(order).toEqual(["response"]);
  });

  it("hands an approval_response to the approvals, and nothing else", () => {
    const resolved: unknown[] = [];
    const sent: unknown[] = [];
    const dispatch = createDispatch({
      applyTaint: () => {},
      session: {} as AgentSession,
      ipc: { send: (record: unknown) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: { resolve: (record: unknown) => void resolved.push(record) } as unknown as Approvals,
      leafMayHaveMoved: () => {},
      setRules: () => {},
    });
    dispatch({ type: "approval_response", id: "a1", answer: "once" });
    dispatch({ type: "approval_response", id: "a2", answer: "deny", cancelled: true });
    expect(resolved).toEqual([
      { type: "approval_response", id: "a1", answer: "once" },
      { type: "approval_response", id: "a2", answer: "deny", cancelled: true },
    ]);
    expect(sent).toEqual([]);
  });

  describe("the taint of a policy update (M5R6, M5R41)", () => {
    const update = (taint: { tainted: boolean; epoch: number }) =>
      ({ type: "policy_update", rules: { ...withAlways, taint } }) as const;
    function bed() {
      const taint = createTaint({ tainted: false, epoch: 0 }, () => {});
      const sent: unknown[] = [];
      const dispatch = createDispatch({
        applyTaint: (next) => taint.apply(next),
        session: {} as AgentSession,
        ipc: { send: (record: unknown) => void sent.push(record) } as unknown as Ipc,
        ui: {} as UiBridge,
        approvals: {} as Approvals,
        leafMayHaveMoved: () => {},
        setRules: () => {},
      });
      return { taint, dispatch, sent };
    }

    it("lowers a raised taint only with a newer epoch", () => {
      const { taint, dispatch } = bed();
      taint.apply({ tainted: true, epoch: 1 });
      dispatch(update({ tainted: false, epoch: 1 }));
      expect(taint.state()).toEqual({ tainted: true, epoch: 1 });
      dispatch(update({ tainted: false, epoch: 0 }));
      expect(taint.state()).toEqual({ tainted: true, epoch: 1 });
      dispatch(update({ tainted: false, epoch: 2 }));
      expect(taint.state()).toEqual({ tainted: false, epoch: 2 });
    });

    it("leaves the taint as it was when the update is malformed", () => {
      const { taint, dispatch, sent } = bed();
      taint.raise();
      dispatch({
        type: "policy_update",
        rules: { profile: "interactive", taint: { tainted: false, epoch: 9 } },
      });
      expect(taint.state()).toEqual({ tainted: true, epoch: 0 });
      expect(sent).toHaveLength(1);
    });
  });
});

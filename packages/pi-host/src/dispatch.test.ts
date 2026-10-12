import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PolicyRules } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "./approvals.ts";
import { createDispatch } from "./dispatch.ts";
import type { Ipc } from "./ipc.ts";
import type { UiBridge } from "./ui-bridge.ts";

const withAlways = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [{ tool: "bash", key: "d".repeat(64) }],
});

describe("dispatch", () => {
  it("drops the always rules when a policy update is malformed, and says so (M2-RT-17)", () => {
    const sent: Array<Record<string, unknown>> = [];
    let rules = withAlways;
    const dispatch = createDispatch({
      session: {} as AgentSession,
      ipc: { send: (record: Record<string, unknown>) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => {},
      rules: () => rules,
      setRules: (next) => {
        rules = next;
      },
    });
    dispatch({ type: "policy_update", rules: { profile: "interactive", approvalMode: "yolo" } });
    expect(rules).toEqual({ ...withAlways, alwaysAllow: [] });
    expect(sent).toEqual([expect.objectContaining({ type: "extension_error", event: "policy_update" })]);
    dispatch({ type: "policy_update", rules: withAlways });
    expect(rules).toEqual(withAlways);
  });

  it("asks for a look at the leaf after navigate_tree has answered, in that order", async () => {
    const order: string[] = [];
    const session = {
      navigateTree: async () => ({ cancelled: false }),
      sessionManager: { getLeafId: () => "e7" },
    } as unknown as AgentSession;
    const dispatch = createDispatch({
      session,
      ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => void order.push("look"),
      rules: () => withAlways,
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
        session,
        ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
        ui: {} as UiBridge,
        approvals: {} as Approvals,
        leafMayHaveMoved: () => void order.push("look"),
        rules: () => withAlways,
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
      session,
      ipc: { send: (record: { type: string }) => void order.push(record.type) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: {} as Approvals,
      leafMayHaveMoved: () => void order.push("look"),
      rules: () => withAlways,
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
      session: {} as AgentSession,
      ipc: { send: (record: unknown) => void sent.push(record) } as unknown as Ipc,
      ui: {} as UiBridge,
      approvals: { resolve: (record: unknown) => void resolved.push(record) } as unknown as Approvals,
      leafMayHaveMoved: () => {},
      rules: () => withAlways,
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
});

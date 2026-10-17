import { type Caller, PLATFORM_OPS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createPlatformPort } from "../platform/index.ts";
import {
  APPROVAL_TTL_MS,
  createApprovedCalls,
  MAX_APPROVED_CALLS,
  isPlatformTool,
} from "./approved-calls.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

describe("the approved calls", () => {
  it("is spent once, and only for the tool it was noted for", () => {
    const calls = createApprovedCalls({ clock: createFakeClock() });
    calls.note("s1", "tc1", "agent_delegate");
    expect(calls.take("s1", "tc1", "bash")).toBe(false);
    expect(calls.take("s1", "tc2", "agent_delegate")).toBe(false);
    expect(calls.take("s2", "tc1", "agent_delegate")).toBe(false);
    expect(calls.take("s1", "tc1", "agent_delegate")).toBe(true);
    expect(calls.take("s1", "tc1", "agent_delegate")).toBe(false);
  });

  it("forgets an answer after 10 minutes", async () => {
    const clock = createFakeClock();
    const calls = createApprovedCalls({ clock });
    calls.note("s1", "tc1", "agent_delegate");
    calls.note("s1", "tc2", "agent_delegate");
    await clock.advance(APPROVAL_TTL_MS - 1);
    expect(calls.take("s1", "tc1", "agent_delegate")).toBe(true);
    await clock.advance(1);
    expect(calls.take("s1", "tc2", "agent_delegate")).toBe(false);
    expect(APPROVAL_TTL_MS).toBe(600_000);
  });

  it("drops the oldest entry when the 4 097th arrives", () => {
    const calls = createApprovedCalls({ clock: createFakeClock() });
    for (let i = 0; i < MAX_APPROVED_CALLS + 1; i++) calls.note("s1", `tc${i}`, "agent_delegate");
    expect(MAX_APPROVED_CALLS).toBe(4096);
    expect(calls.take("s1", "tc0", "agent_delegate")).toBe(false);
    expect(calls.take("s1", "tc1", "agent_delegate")).toBe(true);
    expect(calls.take("s1", `tc${MAX_APPROVED_CALLS}`, "agent_delegate")).toBe(true);
  });

  it("does not let a repeated note take a second slot", () => {
    const calls = createApprovedCalls({ clock: createFakeClock() });
    for (let i = 0; i < MAX_APPROVED_CALLS; i++) calls.note("s1", `tc${i}`, "agent_delegate");
    calls.note("s1", "tc0", "agent_delegate");
    expect(calls.take("s1", "tc1", "agent_delegate")).toBe(true);
    expect(calls.take("s1", "tc0", "agent_delegate")).toBe(true);
  });

  it("knows which tools are platform tools", () => {
    for (const spec of Object.values(PLATFORM_OPS)) expect(isPlatformTool(spec.tool)).toBe(true);
    for (const tool of ["bash", "edit", "agent", "agent.delegate", ""])
      expect(isPlatformTool(tool)).toBe(false);
  });
});

const KEY = "b".repeat(64);
const TOKEN: Caller = { ...OWNER, kind: "token", credentialId: "tok1" };
let bed: ReturnType<typeof open>["bed"];
afterEach(() => {
  bed?.dispose();
  bed = undefined as never;
});

function open() {
  const policy = fakePolicyPort();
  const made = createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { policy },
  );
  bed = made;
  const handler = vi.fn(() => Promise.resolve({ taskId: "t1" }));
  const platform = createPlatformPort({
    sessions: made.service.agent,
    audit: { append: () => {}, reserve: () => true },
    clock: made.clock,
    logger: silentLogger,
    readOnly: false,
  });
  platform.register("agent.delegate", handler as never);
  made.service.agent.setAgentPorts({ platform });
  return { bed: made, policy, handler };
}

/** A tainted agent thread with its worker up. */
async function thread() {
  const opened = open();
  const { sessionId } = await opened.bed.service.create(opened.bed.work, OWNER);
  opened.bed.db.run("UPDATE sessions SET agent_id = 'atlas-0001', agent_role = 'thread' WHERE id = $id", {
    id: sessionId,
  });
  opened.policy.markTainted(OWNER.userId, sessionId, 0);
  return { ...opened, sessionId };
}

const card = (id: string, tool: string, toolCallId: string) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Allow?",
  message: `${tool}: please`,
  answers: ["deny", "once"] as Array<"deny" | "once">,
  tool,
  key: KEY,
  tainted: true,
  toolCallId,
});
const respond = (sessionId: string, dialogId: string, response: object, caller: Caller = OWNER) =>
  bed.service.respondDialog({ sessionId, dialogId, response: response as never }, caller);
const delegate = (id: string, toolCallId: string) =>
  bed.spawned[0]?.emit({
    type: "platform_call",
    id,
    op: "agent.delegate",
    toolCallId,
    args: { agent: "Scout", task: "check it" },
  });
const results = async () => {
  await bed.clock.advance(0);
  return Object.fromEntries(
    (bed.spawned[0]?.sent ?? []).flatMap((r) =>
      r.type === "platform_result" ? [[r.id, r.error ?? "ok"]] : [],
    ),
  );
};
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "other";
  }
};
const answers = () => (bed.spawned[0]?.sent ?? []).filter((r) => r.type === "approval_response");

describe("a tainted delegation and who may allow it", () => {
  it("runs once after the owner's browser allowed that very call on the delegate card", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    respond(sessionId, "d1", { answer: "once" });
    delegate("p1", "tc1");
    delegate("p2", "tc1");
    expect(await results()).toEqual({ p1: "ok", p2: "tainted" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("notes the answer given as a confirmation too", async () => {
    const { sessionId } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    respond(sessionId, "d1", { confirmed: true });
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "ok" });
  });

  it("does not run it after Deny", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    respond(sessionId, "d1", { answer: "deny" });
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a token's answer on the card before the worker sees it, and keeps the card open for the owner", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    expect(codeOf(() => respond(sessionId, "d1", { answer: "once" }, TOKEN))).toBe("forbidden");
    expect(codeOf(() => respond(sessionId, "d1", { answer: "deny" }, TOKEN))).toBe("forbidden");
    expect(codeOf(() => respond(sessionId, "d1", { confirmed: true }, TOKEN))).toBe("forbidden");
    expect(answers()).toEqual([]);
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
    respond(sessionId, "d1", { answer: "once" });
    delegate("p2", "tc1");
    expect(await results()).toEqual({ p1: "tainted", p2: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes a token's once on a bash card to the worker, but never notes it", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("b1", "bash", "tc1"));
    expect(codeOf(() => respond(sessionId, "b1", { answer: "once" }, TOKEN))).toBeNull();
    expect(answers()).toHaveLength(1);
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not spend the owner's once on a bash card on agent.delegate", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("b1", "bash", "tc1"));
    respond(sessionId, "b1", { answer: "once" });
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not spend an answer given on one call's card on another call", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    respond(sessionId, "d1", { answer: "once" });
    delegate("p1", "tc-other");
    expect(await results()).toEqual({ p1: "tainted" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not spend an answer given on another platform tool's card", async () => {
    const { sessionId, handler } = await thread();
    bed.spawned[0]?.emit(card("r1", "agent_remind", "tc1"));
    respond(sessionId, "r1", { answer: "once" });
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("notes only the owner's browser, whoever asks", async () => {
    const { sessionId } = await thread();
    const approved = {
      answer: "once" as const,
      scope: "exact" as const,
      grant: { tool: "agent_delegate", key: KEY, label: "x", toolCallId: "tc1" },
    };
    const { agent } = bed.service;
    agent.noted(sessionId, approved, TOKEN);
    agent.noted(sessionId, { ...approved, answer: "deny" as never }, OWNER);
    agent.noted(sessionId, { ...approved, grant: { ...approved.grant, tool: "bash" } }, OWNER);
    agent.noted(sessionId, { ...approved, grant: { tool: "agent_delegate", key: KEY, label: "x" } }, OWNER);
    expect(agent.approvedCalls.take(sessionId, "tc1", "agent_delegate")).toBe(false);
    agent.noted(sessionId, approved, OWNER);
    expect(agent.approvedCalls.take(sessionId, "tc1", "agent_delegate")).toBe(true);
  });

  it("never notes the automation credential's answer", async () => {
    const { sessionId } = await thread();
    const approved = {
      answer: "once" as const,
      scope: "exact" as const,
      grant: { tool: "agent_delegate", key: KEY, label: "x", toolCallId: "tc1" },
    };
    bed.service.agent.noted(sessionId, approved, { ...OWNER, credentialId: "automation" });
    expect(bed.service.agent.approvedCalls.take(sessionId, "tc1", "agent_delegate")).toBe(false);
  });

  it("forgets the owner's answer after 10 minutes", async () => {
    const { sessionId } = await thread();
    bed.spawned[0]?.emit(card("d1", "agent_delegate", "tc1"));
    respond(sessionId, "d1", { answer: "once" });
    await bed.clock.advance(APPROVAL_TTL_MS + 1);
    delegate("p1", "tc1");
    expect(await results()).toEqual({ p1: "tainted" });
  });
});

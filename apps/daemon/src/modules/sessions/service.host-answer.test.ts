import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type Caller, PolicyRules } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createPlatformPort } from "../platform/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const KEY = "c".repeat(64);
const HOST = "api.example.com";
const TOKEN: Caller = { ...OWNER, kind: "token", credentialId: "tok1" };
const AUTOMATION: Caller = { ...OWNER, credentialId: "automation" };
let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

async function setup() {
  bed = build();
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const { agent } = bed.service;
  agent.setAgentPorts({
    agents: {
      profileOf: (ownerId, agentId) =>
        ownerId === "u1" && agentId === ID
          ? { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }
          : null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    },
  });
  const platform = createPlatformPort({
    sessions: agent,
    audit: { append: () => {}, reserve: () => true },
    clock: bed.clock,
    logger: silentLogger,
    readOnly: false,
  });
  platform.register("network.request", (args, ctx) =>
    Promise.resolve({ granted: agent.hostGrants.has(ctx.sessionId, args.host) }),
  );
  agent.setAgentPorts({ platform });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: "u1",
    agentId: ID,
    role: "thread",
  });
  return sessionId;
}

const card = (id: string, over: Record<string, unknown> = {}) => ({
  type: "approval_request" as const,
  id,
  category: "read" as const,
  title: "pap: allow a host for this thread?",
  message: `network_request asks for ${HOST}.`,
  answers: ["deny", "host"] as Array<"deny" | "host" | "once">,
  tool: "network_request",
  key: KEY,
  tainted: false,
  toolCallId: "tc1",
  host: HOST,
  ...over,
});
const respond = (sessionId: string, dialogId: string, response: object, caller: Caller = OWNER) =>
  bed.service.respondDialog({ sessionId, dialogId, response: response as never }, caller);
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "other";
  }
};
const held = (sessionId: string) => bed.service.agent.hostGrants.of(sessionId);
const answers = () => (bed.spawned[0]?.sent ?? []).filter((record) => record.type === "approval_response");
const asked = async (sessionId: string, host: string) => {
  const before = bed.spawned[0]?.sent.length ?? 0;
  bed.spawned[0]?.emit({
    type: "platform_call",
    id: `p${before}`,
    op: "network.request",
    toolCallId: "tc2",
    args: { host },
  });
  await bed.clock.advance(0);
  const reply = (bed.spawned[0]?.sent ?? [])
    .slice(before)
    .find((record) => record.type === "platform_result");
  return reply?.ok === true ? (reply.result as { granted: boolean }).granted : reply?.error;
};
const lastRules = () => {
  const updates = (bed.spawned[0]?.sent ?? []).filter((record) => record.type === "policy_update");
  const last = updates.at(-1);
  return last?.type === "policy_update" ? PolicyRules.parse(last.rules) : null;
};

describe("a browser's host answer on an agent thread's network_request card (owner a2, M11R209)", () => {
  it("records the host, answers granted on network.request, and puts it in the next rules", async () => {
    const sessionId = await setup();
    expect(await asked(sessionId, HOST)).toBe(false);
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    expect(held(sessionId)).toEqual([HOST]);
    expect(answers()).toEqual([{ type: "approval_response", id: "d1", answer: "host" }]);
    expect(await asked(sessionId, HOST)).toBe(true);
    expect(await asked(sessionId, "other.example.com")).toBe(false);
    expect(lastRules()?.hostGrants).toEqual([HOST]);
  });

  it("records nothing on Deny", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "deny" });
    expect(held(sessionId)).toEqual([]);
  });

  it("refuses a token's host answer with forbidden and keeps the card open for the owner", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    expect(codeOf(() => respond(sessionId, "d1", { answer: "host" }, TOKEN))).toBe("forbidden");
    expect(answers()).toEqual([]);
    expect(held(sessionId)).toEqual([]);
    respond(sessionId, "d1", { answer: "host" });
    expect(held(sessionId)).toEqual([HOST]);
  });

  it("refuses the automation caller's host answer with forbidden and keeps the card open", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    expect(codeOf(() => respond(sessionId, "d1", { answer: "host" }, AUTOMATION))).toBe("forbidden");
    expect(answers()).toEqual([]);
    expect(held(sessionId)).toEqual([]);
    respond(sessionId, "d1", { answer: "host" });
    expect(held(sessionId)).toEqual([HOST]);
  });

  it("answers bad_request for a host answer on a card that did not offer it, and records nothing", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1", { answers: ["deny", "once"], host: undefined }));
    expect(codeOf(() => respond(sessionId, "d1", { answer: "host" }))).toBe("bad_request");
    expect(held(sessionId)).toEqual([]);
  });

  it("refuses a host answer on a plain session's card (a forged record) with forbidden", async () => {
    await setup();
    const { sessionId: plain } = await bed.service.create(bed.work, OWNER);
    bed.spawned.at(-1)?.emit(card("d1"));
    expect(codeOf(() => respond(plain, "d1", { answer: "host" }))).toBe("forbidden");
    expect(held(plain)).toEqual([]);
  });

  it("refuses a host answer on a card of another tool, even on an agent thread", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1", { tool: "bash", category: "exec" }));
    expect(codeOf(() => respond(sessionId, "d1", { answer: "host" }))).toBe("forbidden");
    expect(held(sessionId)).toEqual([]);
  });

  it("records the host of the worker's card, whatever the client sends", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host", host: "evil.example.com" });
    expect(held(sessionId)).toEqual([HOST]);
    expect(await asked(sessionId, "evil.example.com")).toBe(false);
  });
});

describe("the end of a grant (W5-R35)", () => {
  it("is dropped when the thread's session is archived, and an unarchive brings none back", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    bed.service.mark({ sessionId, change: { kind: "archive" } }, OWNER);
    expect(held(sessionId)).toEqual([]);
    bed.service.mark({ sessionId, change: { kind: "unarchive" } }, OWNER);
    expect(held(sessionId)).toEqual([]);
  });

  it("pushes the running worker a policy that no longer holds the grants after a manual archive", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    expect(lastRules()?.hostGrants).toEqual([HOST]);
    bed.service.mark({ sessionId, change: { kind: "archive" } }, OWNER);
    expect(lastRules()?.hostGrants).toEqual([]);
  });

  it.each([
    ["pin", { kind: "pin", before: null }],
    ["snooze", { kind: "snooze", until: -1 }],
    ["settle", { kind: "settle" }],
  ] as const)("is kept when the thread is marked %s", async (_name, mark) => {
    const change = mark.kind === "snooze" ? { ...mark, until: bed.clock.now() + 3_600_000 } : mark;
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    bed.service.mark({ sessionId, change }, OWNER);
    expect(held(sessionId)).toEqual([HOST]);
    expect(lastRules()?.hostGrants).toEqual([HOST]);
  });

  it("is not held by a new thread of the same agent (a reset)", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    const next = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "thread",
    });
    expect(held(next.sessionId)).toEqual([]);
    expect(held(sessionId)).toEqual([HOST]);
  });

  it("is kept when another session is archived", async () => {
    const sessionId = await setup();
    bed.spawned[0]?.emit(card("d1"));
    respond(sessionId, "d1", { answer: "host" });
    const { sessionId: plain } = await bed.service.create(bed.work, OWNER);
    bed.service.mark({ sessionId: plain, change: { kind: "archive" } }, OWNER);
    expect(held(sessionId)).toEqual([HOST]);
  });
});

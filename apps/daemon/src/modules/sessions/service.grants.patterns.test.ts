import { realpathSync } from "node:fs";
import {
  type ApprovalAnswer,
  type AlwaysScopes,
  type DaemonToWorker,
  PapError,
  PolicyRules,
} from "@pap/contracts";
import type { Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const KEY = "a".repeat(64);
const PREFIX = ["pnpm", "test"];
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
const TOKEN: Caller = { ...OWNER, kind: "token", credentialId: "tok1" };

const ask = (id: string, alwaysScopes?: AlwaysScopes, tool = "bash") => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message: "bash: pnpm test --watch",
  answers: ["deny", "session", "always", "once"] as ApprovalAnswer[],
  tool,
  key: KEY,
  tainted: false,
  ...(alwaysScopes ? { alwaysScopes } : {}),
});
const sent = (index: number) => bed.spawned[index]?.sent.filter((r) => r.type === "approval_response") ?? [];
const updates = (index: number): DaemonToWorker[] =>
  bed.spawned[index]?.sent.filter((record) => record.type === "policy_update") ?? [];
const rulesIn = (record: DaemonToWorker | undefined) => (record as { rules: PolicyRules } | undefined)?.rules;
const open = async (scopes: AlwaysScopes | undefined, tool?: string) => {
  const policy = fakePolicyPort();
  bed = build({ policy });
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const frames = await bed.subscribe(sessionId);
  bed.spawned[0]?.emit(ask("d1", scopes, tool));
  await bed.clock.advance(0);
  return { policy, sessionId, frames };
};
const respond = (sessionId: string, response: unknown, caller: Caller = OWNER) =>
  bed.service.respondDialog({ sessionId, dialogId: "d1", response: response as never }, caller);

describe("pattern rules reach the worker", () => {
  it("starts a worker with its project's prefix and tool rules", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy });
    const scope = realpathSync(bed.work);
    policy.addAlways({
      ownerId: OWNER.userId,
      scope,
      tool: "bash",
      kind: "prefix",
      prefix: PREFIX,
      label: "x",
    });
    policy.addAlways({
      ownerId: OWNER.userId,
      scope,
      tool: "mcp__fix__write",
      kind: "tool",
      source: "mcp",
      label: "x",
    });
    await bed.service.create(bed.work, OWNER);
    const init = bed.spawned[0]?.sent.find((record) => record.type === "init");
    expect(init).toMatchObject({
      policy: {
        alwaysAllow: [],
        alwaysPrefixes: [{ prefix: PREFIX }],
        alwaysTools: [{ tool: "mcp__fix__write", source: "mcp" }],
      },
    });
  });

  it("pushes a revoked prefix rule away: the next update no longer has it", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy });
    const scope = realpathSync(bed.work);
    await bed.service.create(bed.work, OWNER);
    policy.addAlways({
      ownerId: OWNER.userId,
      scope,
      tool: "bash",
      kind: "prefix",
      prefix: PREFIX,
      label: "x",
    });
    await bed.clock.advance(0);
    expect(rulesIn(updates(0).at(-1))?.alwaysPrefixes).toEqual([{ prefix: PREFIX }]);
    policy.revokePrefix(OWNER.userId, scope, PREFIX);
    await bed.clock.advance(0);
    expect(rulesIn(updates(0).at(-1))?.alwaysPrefixes).toEqual([]);
  });

  it("sends a stored pattern list the schema refuses as no pattern rule at all, and keeps the exact ones", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy });
    policy.seed(OWNER.userId, realpathSync(bed.work), [{ tool: "bash", key: KEY }]);
    policy.prefixesFor = () => [{ prefix: ["pnpm", "$(id)"] }, { prefix: PREFIX }];
    await bed.service.create(bed.work, OWNER);
    expect(bed.spawned[0]?.sent.find((record) => record.type === "init")).toMatchObject({
      policy: { alwaysAllow: [{ tool: "bash", key: KEY }], alwaysPrefixes: [{ prefix: PREFIX }] },
    });
  });
});

describe("the answer's scope", () => {
  it("shows the offered scopes on the card", async () => {
    const { frames } = await open({ prefix: PREFIX });
    const opened = frames.map((frame) => frame.event as { kind: string; dialog?: unknown });
    expect(opened.find((event) => event.kind === "dialog_open")).toMatchObject({
      dialog: { id: "d1", alwaysScopes: { prefix: PREFIX } },
    });
  });

  it("stores the offered prefix for an always/prefix answer and tells the worker the scope", async () => {
    const { policy, sessionId } = await open({ prefix: PREFIX });
    respond(sessionId, { answer: "always", scope: "prefix" });
    expect(policy.added).toEqual([
      {
        ownerId: OWNER.userId,
        scope: realpathSync(bed.work),
        tool: "bash",
        kind: "prefix",
        prefix: PREFIX,
        label: "bash: pnpm test --watch",
      },
    ]);
    expect(sent(0)).toEqual([{ type: "approval_response", id: "d1", answer: "always", scope: "prefix" }]);
    expect(rulesIn(updates(0).at(-1))?.alwaysPrefixes).toEqual([{ prefix: PREFIX }]);
  });

  it("takes the prefix from the stored request, never from words the client's frame carried", async () => {
    const { policy, sessionId } = await open({ prefix: PREFIX });
    respond(sessionId, {
      answer: "always",
      scope: "prefix",
      prefix: ["rm", "-rf"],
      pattern: ["sh"],
      key: "b".repeat(64),
    });
    expect(policy.added).toHaveLength(1);
    expect(policy.added[0]).toMatchObject({ kind: "prefix", prefix: PREFIX });
    expect(JSON.stringify(policy.added)).not.toContain("rm");
  });

  it("stores a tool rule with the source the card offered", async () => {
    const { policy, sessionId } = await open({ tool: true, toolSource: "mcp" }, "mcp__fix__write");
    respond(sessionId, { answer: "always", scope: "tool" });
    expect(policy.added).toEqual([
      expect.objectContaining({ tool: "mcp__fix__write", kind: "tool", source: "mcp" }),
    ]);
    expect(sent(0)).toEqual([{ type: "approval_response", id: "d1", answer: "always", scope: "tool" }]);
  });

  it("stores the exact call for scope exact or no scope at all", async () => {
    const { policy, sessionId } = await open({ prefix: PREFIX });
    respond(sessionId, { answer: "always", scope: "exact" });
    expect(policy.added).toEqual([expect.objectContaining({ kind: "exact", key: KEY })]);
    expect(sent(0)).toEqual([{ type: "approval_response", id: "d1", answer: "always", scope: "exact" }]);
  });

  it.each([
    ["a prefix on a card that offered none", undefined, { answer: "always", scope: "prefix" }],
    [
      "a prefix on a card that offered only a tool",
      { tool: true, toolSource: "mcp" },
      { answer: "always", scope: "prefix" },
    ],
    ["a tool on a card that offered a prefix", { prefix: PREFIX }, { answer: "always", scope: "tool" }],
    ["a tool without its source", { tool: true }, { answer: "always", scope: "tool" }],
    ["a scope with the answer once", { prefix: PREFIX }, { answer: "once", scope: "prefix" }],
    ["a scope with the answer session", { prefix: PREFIX }, { answer: "session", scope: "exact" }],
    ["a scope outside the three", { prefix: PREFIX }, { answer: "always", scope: "glob" }],
  ])("refuses %s with bad_request and keeps the question open", async (_name, scopes, response) => {
    const { policy, sessionId } = await open(scopes as AlwaysScopes | undefined);
    expect(() => respond(sessionId, response)).toThrow(new PapError("bad_request"));
    expect(sent(0)).toEqual([]);
    expect(policy.added).toEqual([]);
    respond(sessionId, { answer: "once" });
    expect(sent(0)).toEqual([{ type: "approval_response", id: "d1", answer: "once" }]);
  });

  it("keeps a token to deny and once whatever scope it names", async () => {
    const { policy, sessionId } = await open({ prefix: PREFIX });
    expect(() => respond(sessionId, { answer: "always", scope: "prefix" }, TOKEN)).toThrow(
      new PapError("forbidden"),
    );
    expect(sent(0)).toEqual([]);
    expect(policy.added).toEqual([]);
  });

  it("tells the person when the project is full, and the call they allowed still runs", async () => {
    const policy = fakePolicyPort({ full: true });
    bed = build({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    bed.spawned[0]?.emit(ask("d1", { prefix: PREFIX }));
    await bed.clock.advance(0);
    respond(sessionId, { answer: "always", scope: "prefix" });
    expect(sent(0)).toMatchObject([{ answer: "always", scope: "prefix" }]);
    const notices = frames
      .map((frame) => frame.event as { kind: string; code?: string })
      .filter((event) => event.kind === "notice");
    expect(notices).toEqual([expect.objectContaining({ code: "rules_full" })]);
  });
});

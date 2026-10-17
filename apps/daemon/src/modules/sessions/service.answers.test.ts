import { type Caller, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditPort } from "../audit/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const KEY = "a".repeat(64);
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

type Context = Parameters<AuditPort["fromWorker"]>[2];
const TOKEN: Caller = { ...OWNER, kind: "token", credentialId: "tok1" };

function open() {
  const policy = fakePolicyPort();
  const handed: Array<{ raw: unknown; context: Context }> = [];
  bed = build({
    policy,
    audit: {
      append: () => {},
      reserve: () => true,
      fromWorker: (_session, raw, context) => {
        handed.push({ raw, context });
        return null;
      },
    },
  });
  return { policy, handed };
}
const ask = (id: string, toolCallId?: string) => ({
  type: "approval_request" as const,
  id,
  category: "exec" as const,
  title: "Run?",
  message: "bash: npm test",
  answers: ["deny", "session", "always", "once"] as Array<"deny" | "session" | "always" | "once">,
  tool: "bash",
  key: KEY,
  tainted: false,
  ...(toolCallId === undefined ? {} : { toolCallId }),
});
const callEntry = (toolCallId: string, decision: "approved" | "denied") => ({
  type: "audit" as const,
  entry: {
    kind: "call",
    toolCallId,
    tool: "bash",
    category: "exec",
    decision,
    stages: [{ stage: "01", outcome: "pass" }],
    args: "npm test",
  },
});
const sent = (index: number) => bed.spawned[index]?.sent.filter((r) => r.type === "approval_response") ?? [];

describe("a token answers deny or once only (Q7, M4 of the M5 final review)", () => {
  it.each(["always", "session"] as const)(
    "refuses %s with forbidden and keeps the question open",
    async (answer) => {
      const { policy } = open();
      const { sessionId } = await bed.service.create(bed.work, OWNER);
      bed.spawned[0]?.emit(ask("d1"));
      await bed.clock.advance(0);
      expect(() =>
        bed.service.respondDialog({ sessionId, dialogId: "d1", response: { answer } }, TOKEN),
      ).toThrow(new PapError("forbidden"));
      expect(sent(0)).toEqual([]);
      expect(policy.added).toEqual([]);
      // Still open: the same token can answer once, and the worker hears it.
      bed.service.respondDialog({ sessionId, dialogId: "d1", response: { answer: "once" } }, TOKEN);
      expect(sent(0)).toMatchObject([{ answer: "once" }]);
    },
  );

  it.each(["deny", "once"] as const)("lets a token answer %s", async (answer) => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(ask("d1"));
    await bed.clock.advance(0);
    bed.service.respondDialog({ sessionId, dialogId: "d1", response: { answer } }, TOKEN);
    expect(sent(0)).toMatchObject([{ answer }]);
  });

  it("still lets a browser session answer always", async () => {
    const { policy } = open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(ask("d1"));
    await bed.clock.advance(0);
    bed.service.respondDialog({ sessionId, dialogId: "d1", response: { answer: "always" } }, OWNER);
    expect(policy.added).toHaveLength(1);
  });
});

describe("the approved row names who answered", () => {
  it("hands the audit module the credential of the answer, matched on the tool call", async () => {
    const { handed } = open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    for (const [id, toolCallId, caller] of [
      ["d1", "tc1", TOKEN],
      ["d2", "tc2", OWNER],
    ] as const) {
      bed.spawned[0]?.emit(ask(id, toolCallId));
      await bed.clock.advance(0);
      bed.service.respondDialog({ sessionId, dialogId: id, response: { answer: "once" } }, caller);
    }
    // Rows reach the audit module in the order the worker writes them, not the order of the answers.
    bed.spawned[0]?.emit(callEntry("tc2", "approved"));
    bed.spawned[0]?.emit(callEntry("tc1", "approved"));
    bed.spawned[0]?.emit(callEntry("tc3", "approved"));
    await bed.clock.advance(0);
    expect(handed.map((h) => h.context.answeredBy)).toEqual([
      { actor: "user", actorId: OWNER.credentialId },
      { actor: "token", actorId: "tok1" },
      undefined,
    ]);
  });

  it("names the answerer of a denied call too, once", async () => {
    const { handed } = open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(ask("d1", "tc1"));
    await bed.clock.advance(0);
    bed.service.respondDialog({ sessionId, dialogId: "d1", response: { answer: "deny" } }, TOKEN);
    bed.spawned[0]?.emit(callEntry("tc1", "denied"));
    bed.spawned[0]?.emit(callEntry("tc1", "denied"));
    await bed.clock.advance(0);
    expect(handed.map((h) => h.context.answeredBy)).toEqual([{ actor: "token", actorId: "tok1" }, undefined]);
  });
});

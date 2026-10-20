import { afterEach, describe, expect, it } from "vitest";
import { createAuditService } from "./service.ts";
import { createAuditStore } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

let current: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => current?.dispose());

const SESSION = { id: "s1", ownerId: "u1" } as const;
const call = {
  kind: "call",
  toolCallId: "c1",
  tool: "bash",
  category: "exec",
  decision: "approved",
  reason: "answer: once",
  stages: [{ stage: "01", outcome: "pass" }],
  args: "ls",
};
const result = (fields: Record<string, unknown> = {}) => ({
  kind: "result",
  toolCallId: "c1",
  tool: "bash",
  stages: [],
  redactions: 0,
  external: false,
  ...fields,
});

function bed() {
  current = createAuditBed();
  const store = createAuditStore(current.db);
  const service = createAuditService({ store, clock: current.clock, logger: current.logger });
  const last = () => store.page({ ownerId: "u1", limit: 1 })[0];
  return { service, store, last };
}

describe("the audit stores how a card was answered and what a command did (decision 117, A4)", () => {
  it("stores askedAt <= answeredAt and the offered answers on the call row", () => {
    const { service, last } = bed();
    service.fromWorker(SESSION, call, {
      containment: "none",
      card: { askedAt: 1_000, answers: ["deny", "once", "always"], answeredAt: 4_200, answer: "always" },
    });
    expect(last()).toMatchObject({
      kind: "call",
      askedAt: 1_000,
      answers: ["deny", "once", "always"],
      answeredAt: 4_200,
      answer: "always",
    });
  });

  it("stores askedAt and a null answeredAt for a card nobody answered", () => {
    const { service, last } = bed();
    service.fromWorker(
      SESSION,
      { ...call, decision: "denied", reason: "dialog closed" },
      {
        containment: "none",
        card: { askedAt: 1_000, answers: ["deny", "once"], answeredAt: null, answer: null },
      },
    );
    expect(last()).toMatchObject({
      askedAt: 1_000,
      answers: ["deny", "once"],
      answeredAt: null,
      answer: null,
    });
  });

  it("reads null for a call that never asked", () => {
    const { service, last } = bed();
    service.fromWorker(SESSION, { ...call, decision: "allow" }, { containment: "none" });
    expect(last()).toMatchObject({
      askedAt: null,
      answers: null,
      answeredAt: null,
      answer: null,
      exitCode: null,
    });
  });

  it("stores a shell result's exit code and every result's duration", () => {
    const { service, last } = bed();
    service.fromWorker(SESSION, result({ exitCode: 3, durationMs: 42 }), { containment: "none" });
    expect(last()).toMatchObject({ kind: "result", exitCode: 3, durationMs: 42 });
  });

  it("stores a null exit code for a tool that is not a shell", () => {
    const { service, last } = bed();
    service.fromWorker(SESSION, result({ tool: "web_fetch", durationMs: 7 }), { containment: "none" });
    expect(last()).toMatchObject({ exitCode: null, durationMs: 7 });
  });

  it("lists the new fields through audit.list, null on a row that has none", () => {
    const { service } = bed();
    service.fromWorker(SESSION, call, {
      containment: "none",
      card: { askedAt: 1_000, answers: ["deny", "once"], answeredAt: 2_000, answer: "once" },
    });
    service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: "mode changed" });
    const { entries } = service.list({ userId: "u1" } as never, {});
    expect(entries[0]).toMatchObject({
      askedAt: null,
      answers: null,
      answeredAt: null,
      answer: null,
    });
    expect(entries[1]).toMatchObject({
      askedAt: 1_000,
      answers: ["deny", "once"],
      answeredAt: 2_000,
      answer: "once",
    });
  });

  it("ignores a card on a row that is not a call", () => {
    const { service, last } = bed();
    service.fromWorker(SESSION, result(), {
      containment: "none",
      card: { askedAt: 1, answers: ["deny", "once"], answeredAt: 2, answer: "once" },
    });
    expect(last()).toMatchObject({ askedAt: null });
  });
});

import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createPolicyLink } from "./policy-link.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";

const ROW: SessionRow = {
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: "/work",
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
};
const call = (toolCallId: string, decision: string) => ({
  kind: "call",
  toolCallId,
  tool: "bash",
  category: "exec",
  decision,
  stages: [],
  args: "ls",
});

function setup() {
  const clock = createFakeClock(5_000);
  const contexts: unknown[] = [];
  const link = createPolicyLink({
    policy: fakePolicyPort(),
    audit: {
      append: () => {},
      reserve: () => true,
      fromWorker: (_row, _raw, context) => {
        contexts.push(context);
        return null;
      },
    },
    containment: "none",
    clock,
    logger: silentLogger,
    hub: { publish: () => {} },
    sessions: () => [] as LiveSession[],
    toolPreset: () => null,
  });
  return { link, clock, contexts };
}

describe("the call row carries how its card was answered (decision 117, A4)", () => {
  it("hands the audit the offered answers, when the card was shown and when it was answered", async () => {
    const { link, clock, contexts } = setup();
    link.cardShown(ROW, "c1", ["deny", "once"], clock.now());
    await clock.advance(1_500);
    link.answeredBy(ROW, "c1", { userId: "u1", credentialId: "dev1" } as never, "once");
    link.audited(ROW, call("c1", "approved"));
    expect(contexts[0]).toMatchObject({
      card: { askedAt: 5_000, answers: ["deny", "once"], answeredAt: 6_500, answer: "once" },
    });
  });

  it("leaves answeredAt null for a card nobody answered (the session closed)", () => {
    const { link, clock, contexts } = setup();
    link.cardShown(ROW, "c2", ["deny", "once"], clock.now());
    link.audited(ROW, call("c2", "denied"));
    expect(contexts[0]).toMatchObject({
      card: { askedAt: 5_000, answers: ["deny", "once"], answeredAt: null },
    });
  });

  it("gives a call that asked nothing no card, and a card only once", () => {
    const { link, clock, contexts } = setup();
    link.audited(ROW, call("c3", "allow"));
    link.cardShown(ROW, "c4", ["deny", "once"], clock.now());
    link.audited(ROW, call("c4", "denied"));
    link.audited(ROW, call("c4", "denied"));
    expect(contexts.map((context) => "card" in (context as object))).toEqual([false, true, false]);
  });

  it("keys a card by session: another session's call of the same id gets none", () => {
    const { link, clock, contexts } = setup();
    link.cardShown(ROW, "c5", ["deny", "once"], clock.now());
    link.audited({ ...ROW, id: "s2" }, call("c5", "approved"));
    expect(contexts[0]).not.toHaveProperty("card");
  });

  it("keeps the answer the owner chose when the call is then refused", () => {
    const { link, clock, contexts } = setup();
    link.cardShown(ROW, "c6", ["deny", "once", "always"], clock.now());
    link.answeredBy(ROW, "c6", { userId: "u1", credentialId: "dev1" } as never, "always");
    link.audited(ROW, call("c6", "block"));
    expect(contexts[0]).toMatchObject({ card: { answer: "always" } });
  });

  // The oldest card is forgotten past 1 024 (MAX_CARDS), one at a time; the newest stay.
  it("forgets the oldest card once 1 024 are waiting, and keeps the rest", () => {
    const { link, clock, contexts } = setup();
    for (let i = 0; i <= 1_024; i++) link.cardShown(ROW, `k${i}`, ["deny", "once"], clock.now());
    link.audited(ROW, call("k0", "denied"));
    link.audited(ROW, call("k1", "denied"));
    link.audited(ROW, call("k1024", "denied"));
    expect(contexts.map((context) => "card" in (context as object))).toEqual([false, true, true]);
  });
});

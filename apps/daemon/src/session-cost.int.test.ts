import { realpathSync } from "node:fs";
import type { EventFrame, SessionCost } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "one" }] });
});
afterEach(async () => {
  await t.stop();
});

const kindOf = (frame: EventFrame) => (frame.event as { kind?: string }).kind;
const costOf = (frame: EventFrame): SessionCost => (frame.event as { cost: SessionCost }).cost;

describe("the session cost on the stream", () => {
  it("a prompt's run puts its cost on the session stream and a fresh snapshot carries it", async () => {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    const second = await t.connect(cookie);
    try {
      const created = await client.call("sessions.create", { cwd: realpathSync(t.cwd) });
      if (!created.ok) throw new Error("sessions.create failed");
      const sessionId = (created.result as { sessionId: string }).sessionId;
      const sub = ((await client.call("subscribe.session", { sessionId })) as { result: { sub: string } })
        .result.sub;
      await client.waitForEvent((f) => f.sub === sub && kindOf(f) === "snapshot");
      await client.waitForEvent((f) => f.sub === sub && (f.event as { status?: string }).status === "idle");
      await client.call("sessions.prompt", { sessionId, text: "go" });
      await client.waitForEvent(
        (f) => f.sub === sub && kindOf(f) === "cost" && costOf(f).runUsd === null,
        30_000,
      );
      const costs = client.events.filter((f) => f.sub === sub && kindOf(f) === "cost");
      const last = costOf(costs.at(-1) as EventFrame);
      expect(last.sessionUsd).toBe(t.daemon.inspect.sessionCost(sessionId));
      expect(last).toMatchObject({ billing: "api", runUsd: null });
      const sub2 = ((await second.call("subscribe.session", { sessionId })) as { result: { sub: string } })
        .result.sub;
      const snapshot = await second.waitForEvent((f) => f.sub === sub2 && kindOf(f) === "snapshot");
      expect((snapshot.event as { cost: SessionCost }).cost).toEqual(last);
    } finally {
      client.close();
      second.close();
    }
  });
});

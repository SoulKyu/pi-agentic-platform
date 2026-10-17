import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createJudge } from "./judge.ts";
import { scopeOf } from "./testing/bed.ts";

function setup() {
  const pending: Array<(answers: string[]) => void> = [];
  const judge = createJudge({
    clock: createFakeClock(),
    logger: captureLogger().logger,
    resolve: () => new Promise<string[]>((resolve) => pending.push(resolve)),
    denies: () => false,
    resolveMs: 5000,
  });
  return { judge, pending };
}

describe("the judge's lookup bookkeeping", () => {
  it("keeps no entry for a command or a session once its lookups are done", async () => {
    const { judge, pending } = setup();
    const lane = {};
    const decided = judge.decide(scopeOf(), lane, "connect", "allowed.test", 443);
    await Promise.resolve();
    expect(judge.busyKeys()).toBe(2);
    pending[0]?.(["127.7.0.1"]);
    expect(await decided).toEqual({ ips: ["127.7.0.1"], host: "allowed.test" });
    expect(judge.busyKeys()).toBe(0);
  });

  it("returns every answer, in order", async () => {
    const { judge, pending } = setup();
    const decided = judge.decide(scopeOf(), {}, "connect", "allowed.test", 443);
    await Promise.resolve();
    pending[0]?.(["127.7.0.3", "127.7.0.1"]);
    expect(await decided).toMatchObject({ ips: ["127.7.0.3", "127.7.0.1"] });
  });
});

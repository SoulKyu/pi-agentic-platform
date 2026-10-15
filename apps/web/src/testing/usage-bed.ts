import type { LimitView, UsageStreamEvent } from "@pap/contracts";
import { fakeRuntime } from "./runtime-bed.ts";

export const limitView = (patch: Partial<LimitView> = {}): LimitView => ({
  sessionId: "sess-1",
  runId: "run-1",
  resetAt: Date.UTC(2026, 9, 14, 14, 30),
  resume: "scheduled",
  provider: "anthropic",
  model: "sonnet",
  ...patch,
});

export const usageSnapshot = (
  limits: LimitView[] = [],
  patch: Partial<Extract<UsageStreamEvent, { kind: "snapshot" }>> = {},
): UsageStreamEvent => ({ kind: "snapshot", limits, todayUsd: 0, budgetUsd: 5, autoResume: true, ...patch });

/** A fake runtime whose `subscribe.usage` opens a sub; `emitUsage` sends an event on it as the server would. */
export function usageRuntime() {
  const bed = fakeRuntime();
  let seq = 100;
  bed.handlers["subscribe.usage"] = () => ({ sub: "usage-sub" });
  return {
    ...bed,
    emitUsage: (event: UsageStreamEvent) =>
      bed.fake.deliver({ sub: "usage-sub", epoch: "e1", seq: seq++, event }),
  };
}

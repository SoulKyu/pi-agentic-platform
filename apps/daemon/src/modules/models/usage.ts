import { isProviderUsageId, type ModelsUsageResult, type ProviderUsageId } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

/** One answer per provider is kept this long: a loop of clicks costs one request a minute (M10R110). */
export const USAGE_CACHE_MS = 60_000;

interface Kept {
  readonly answer?: ModelsUsageResult;
  readonly expiresAt: number;
  /** The run in flight: calls made meanwhile share it instead of starting another. */
  readonly pending?: Promise<ModelsUsageResult>;
}

/**
 * Provider usage as the owner asks for it. At most one entry per supported provider (ten), so the map is bounded by
 * construction; an unsupported id is answered before anything is kept or run. A helper error is not kept: the next
 * click asks again. A failed query is: a broken key is not asked again within the minute.
 */
export function createProviderUsage(deps: {
  readonly clock: Clock;
  ask(providerId: ProviderUsageId): Promise<ModelsUsageResult>;
}) {
  const kept = new Map<ProviderUsageId, Kept>();
  return {
    get(providerId: string): Promise<ModelsUsageResult> {
      if (!isProviderUsageId(providerId)) return Promise.resolve({ status: "unsupported" });
      const entry = kept.get(providerId);
      if (entry?.pending) return entry.pending;
      if (entry?.answer && deps.clock.now() < entry.expiresAt) return Promise.resolve(entry.answer);
      const pending = deps.ask(providerId).then(
        (answer) => {
          kept.set(providerId, { answer, expiresAt: deps.clock.now() + USAGE_CACHE_MS });
          return answer;
        },
        (error: unknown) => {
          kept.delete(providerId);
          throw error;
        },
      );
      kept.set(providerId, { pending, expiresAt: 0 });
      return pending;
    },
  };
}

import { PapError } from "@pap/contracts";
import { vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { HelperHandle, HelperPool, HelperRunOptions } from "../../../kernel/helper/pool.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import type { AuditPort } from "../../audit/index.ts";
import type { ProjectsPort } from "../../projects/index.ts";
import type { SettingsPort } from "../../settings/index.ts";
import { createModelsService } from "../index.ts";

export interface RunCall {
  readonly op: string;
  readonly params: unknown;
  readonly options: HelperRunOptions;
}

/** A pool whose runs end as the test says: a result, or a rejection with an error code. */
export function fakePool(answer: (call: RunCall) => unknown | PapError) {
  const calls: RunCall[] = [];
  const pool: HelperPool = {
    run: (op, params, options): HelperHandle => {
      const call = { op, params, options };
      calls.push(call);
      const outcome = answer(call);
      const done =
        outcome instanceof PapError
          ? Promise.reject(outcome)
          : outcome instanceof Promise
            ? outcome
            : Promise.resolve(outcome);
      done.catch(() => {});
      return { done, answer: () => false, cancel: () => {} };
    },
    active: () => 0,
    stopAll: async () => {},
  };
  return { pool, calls };
}

/** The owner's `models` setting as the settings port reads it: off, the default (M7R138). */
export const settingsOff: Pick<SettingsPort, "models"> = { models: () => ({ modelsDevPricing: false }) };

/** The sign-in dependencies of a service whose test does not look at them. */
export const signInDeps = {
  clock: createFakeClock(),
  audit: { append: () => {} },
  hub: { publish: () => {}, registerSnapshot: () => {}, onLastSubscriberLeft: () => {} },
  settings: settingsOff,
};

export function modelsBed(
  answer: (call: RunCall) => unknown | PapError,
  roots: Record<string, string[]> = { u1: ["/w/api"] },
  settings: Pick<SettingsPort, "models"> = settingsOff,
) {
  const { pool, calls } = fakePool(answer);
  const { logger, lines } = captureLogger();
  const projects: Pick<ProjectsPort, "covers"> = {
    covers: vi.fn((ownerId: string, cwd: string) =>
      (roots[ownerId] ?? []).some((root) => cwd === root || cwd.startsWith(`${root}/`)),
    ),
  };
  const clock = createFakeClock();
  const audit: Array<Parameters<AuditPort["append"]>[0]> = [];
  const published: Array<{ stream: string; key: string; event: unknown }> = [];
  const leftListeners: Array<(key: string) => void> = [];
  const service = createModelsService({
    helpers: pool,
    projects,
    logger,
    clock,
    audit: { append: (line) => void audit.push(line) },
    hub: {
      publish: (stream, key, event) => void published.push({ stream, key, event }),
      registerSnapshot: () => {},
      onLastSubscriberLeft: (_stream, listener) => void leftListeners.push(listener),
    },
    settings,
  });
  /** The hub telling that nobody watches `flowId` any more. */
  const lastSubscriberLeft = (flowId: string) => leftListeners.forEach((listener) => listener(flowId));
  return { service, calls, lines, projects, clock, audit, published, lastSubscriberLeft };
}

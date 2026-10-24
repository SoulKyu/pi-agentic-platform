import { type Caller, type ManualFireResult, PapError, PRECHECK_REMOVED } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Fire } from "./fire.ts";
import { refuseStoredPrecheck } from "./precheck-refusal.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface ManualDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fire: Fire;
  readonly triggers: { get(ownerId: string, id: string): TriggerRecord | null };
}

/**
 * `automation.fire` (M10R63): fires the saved trigger by hand, even a disabled one. A stored precheck is refused as an
 * answer (`precheck_removed`), not an error. The budget gates a token's fire and not the browser's (the owner's action); both are counted.
 * A payload is fenced as the trigger's source would fence it, so a test fire starts tainted like the real one.
 */
export function createManual(deps: ManualDeps) {
  return {
    async fire(caller: Caller, triggerId: string, payload: string | undefined): Promise<ManualFireResult> {
      const record = deps.triggers.get(caller.userId, triggerId);
      if (record === null) throw new PapError("not_found");
      const config = record.input;
      // The agent's thread is trusted (C §6.1, M11R65): outside text never reaches it, and a token never fires it.
      if (config?.execution.agent?.target === "thread") {
        if (payload !== undefined && payload !== "") throw new PapError("bad_request");
        if (caller.kind === "token") throw new PapError("forbidden");
      }
      if (refuseStoredPrecheck(deps, record, "manual")) return { verdict: "error", detail: PRECHECK_REMOVED };
      const text = payload === undefined || payload === "" ? null : payload;
      const result = deps.fire(record.id, record.revision, {
        ownerId: caller.userId,
        source: "manual",
        payload:
          text === null ? null : { text, source: config?.source.type === "webhook" ? "webhook" : "manual" },
        dedupKey: null,
        title: record.name,
        detail: text,
        gated: caller.kind === "token",
        gates: { exemptDisabled: true },
        retry: null,
      });
      switch (result.verdict) {
        case "fired":
          if (result.taskId !== undefined) return { verdict: "fired", taskId: result.taskId };
          break;
        case "paused":
          throw new PapError("automation_paused");
        case "budget":
          throw new PapError("budget_reached");
        case "queue_full":
          throw new PapError("rate_limited");
        case "error":
          return { verdict: "error", detail: result.detail ?? "error" };
        default:
          break;
      }
      deps.logger.error("manual_fire_unexpected", { verdict: result.verdict });
      return { verdict: "error", detail: "error" };
    },
  };
}
export type Manual = ReturnType<typeof createManual>;

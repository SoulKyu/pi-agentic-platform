import {
  type Activity,
  type CommandInput,
  type ErrorCode,
  IDLE_ACTIVITY,
  type PiEvent,
  type SessionStreamEvent,
  WORKER_BUSY,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { clip } from "./worker-text.ts";

export type CommandAnswer = { ok: true; data: unknown } | { ok: false; error: string };

export interface LiveCommands {
  /**
   * Sends the command now (the request is on the wire when this returns) and counts it until it is answered. A worker
   * that refuses answers `{ ok: false }`; one that is gone or too slow rejects with the `PapError` of the handle.
   */
  command(input: CommandInput): Promise<CommandAnswer>;
  /** Commands sent and not answered yet. */
  inFlight(): number;
  /** `navigate_tree` and `compact`: the commands that move or rewrite the branch (M2R88). */
  structuralInFlight(): number;
  compactInFlight(): number;
  /** Compaction and automatic retry as Pi last said them. */
  activity(): Activity;
  /** The `activity` event a Pi event calls for, or null when the event changes nothing (so none is published twice). */
  onPiEvent(event: PiEvent): SessionStreamEvent | null;
  /** The worker is gone: nothing compacts or retries any more. In-flight commands settle by themselves, with `worker_failed`. */
  reset(): void;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Why a worker refused a command, as the code a client may be told. The worker's text is never returned (R66, M2R87):
 * the only text this reads is Pi's one message for a compaction with nothing to compact and pap's own busy marker,
 * and only to pick the code.
 */
export function refusalOf(command: CommandInput["type"], error: string): ErrorCode {
  if (error === WORKER_BUSY) return "session_busy";
  return command === "compact" && /nothing to compact/i.test(error) ? "session_empty" : "command_failed";
}

/** Where Pi puts the text of a failure in the events it emits; the stream carries a flag instead (R66). */
const ERROR_FIELDS: Readonly<Record<string, string>> = {
  compaction_end: "errorMessage",
  auto_retry_start: "errorMessage",
  auto_retry_end: "finalError",
  summarization_retry_scheduled: "errorMessage",
};

const STRUCTURAL: ReadonlySet<CommandInput["type"]> = new Set(["navigate_tree", "compact"]);

export function createLiveCommands(deps: { handle: WorkerHandle; logger: Logger }): LiveCommands {
  let inFlight = 0;
  let structural = 0;
  let compacts = 0;
  let activity: Activity = IDLE_ACTIVITY;

  const changed = (next: Activity): SessionStreamEvent | null => {
    const same =
      next.compacting === activity.compacting &&
      next.retry?.attempt === activity.retry?.attempt &&
      next.retry?.maxAttempts === activity.retry?.maxAttempts;
    if (same) return null;
    activity = next;
    return { kind: "activity", activity };
  };

  return {
    command(input) {
      const type = input.type;
      inFlight++;
      if (STRUCTURAL.has(type)) structural++;
      if (type === "compact") compacts++;
      const settle = () => {
        inFlight--;
        if (STRUCTURAL.has(type)) structural--;
        if (type === "compact") compacts--;
      };
      let request: ReturnType<WorkerHandle["request"]>;
      try {
        request = deps.handle.request(input);
      } catch (error) {
        settle();
        throw error;
      }
      return request.then(
        (response): CommandAnswer => {
          settle();
          return response.success
            ? { ok: true, data: response.data }
            : { ok: false, error: response.error ?? "" };
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      );
    },
    inFlight: () => inFlight,
    structuralInFlight: () => structural,
    compactInFlight: () => compacts,
    activity: () => activity,
    onPiEvent(event) {
      const field = ERROR_FIELDS[event.type];
      const text = field === undefined ? undefined : event[field];
      if (typeof text === "string") {
        deps.logger.info("pi_error_text", { event: event.type, error: clip(text) });
      }
      switch (event.type) {
        case "compaction_start":
          return changed({ ...activity, compacting: true });
        case "compaction_end":
          return changed({ ...activity, compacting: false });
        case "auto_retry_start": {
          const { attempt, maxAttempts } = event as { attempt?: unknown; maxAttempts?: unknown };
          if (!isCount(attempt) || !isCount(maxAttempts)) {
            deps.logger.debug("auto_retry_unreadable");
            return null;
          }
          return changed({ ...activity, retry: { attempt, maxAttempts } });
        }
        case "auto_retry_end":
        case "agent_start":
          return changed({ ...activity, retry: null });
        default:
          return null;
      }
    },
    reset() {
      activity = IDLE_ACTIVITY;
    },
  };
}

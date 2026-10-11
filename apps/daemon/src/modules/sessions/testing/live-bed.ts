import type { InitRecord, SessionStreamEvent } from "@pap/contracts";
import { type Clock, createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import { type Logger, silentLogger } from "../../../kernel/logger.ts";
import type { WorkerExit } from "../../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../../kernel/supervisor/worker.ts";
import { createFakeWorker } from "../../../kernel/testing/fake-worker.ts";

export const INIT: InitRecord = {
  type: "init",
  cwd: "/w",
  agentDir: "/a",
  papHome: "/p",
  umask: 0o022,
  policy: {},
};
export const confirm = {
  type: "extension_ui_request" as const,
  id: "d1",
  method: "confirm",
  title: "Run a command?",
  message: "bash: ls",
};
export const piEvent = (event: { type: string } & Record<string, unknown>) => ({
  type: "pi_event" as const,
  event,
});
export const READY = { type: "ready" as const, sessionFile: "/f", sessionId: "s1", piVersion: "1.1.0" };

export interface Options {
  compacting?: boolean;
  /** Pi is in the middle of a reply when asked: `get_state` says so. */
  streaming?: boolean;
  /** How the worker answers a prompt that starts nothing, when it answers at all (default `started`). */
  disposition?: "started" | "queued" | "handled";
  promptFails?: boolean;
  holdPrompt?: boolean;
  neverReady?: boolean;
  logger?: Logger;
  sessionFile?: string;
}

/** What `startLiveSession` is given. A helper in `testing/` may import a module only through its index, so the test files pass the function in. */
export interface LiveParts {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(event: SessionStreamEvent): void;
  record(kind: string, data: unknown): void;
  onActivity(): void;
  onExit(exit: WorkerExit): void;
}

export const createLiveBed = <Live>(start: (parts: LiveParts, init: InitRecord) => Live) =>
  function setup(options: Options = {}) {
    const clock: FakeClock = createFakeClock();
    const published: SessionStreamEvent[] = [];
    const recorded: Array<[string, unknown]> = [];
    const exits: WorkerExit[] = [];
    const activity = { count: 0 };
    /** What the worker's `get_state` answers (or whether it answers at all): a test changes it as Pi's run progresses. */
    const pi = { streaming: options.streaming ?? false, holdState: false };
    const worker = createFakeWorker({
      clock,
      reply: (command) => {
        if (command.type === "get_state") {
          // Held until the test answers it, to put the answer where it wants it among other records.
          if (pi.holdState) return undefined;
          return {
            data: {
              isStreaming: pi.streaming,
              isCompacting: options.compacting ?? false,
              pendingMessageCount: 0,
              sessionFile: "/f",
              sessionId: "s1",
            },
          };
        }
        if (command.type === "prompt") {
          if (options.holdPrompt) return undefined;
          return options.promptFails
            ? { success: false, error: "No API key for provider x" }
            : { data: { disposition: options.disposition ?? "started" } };
        }
        return {};
      },
    });
    const live = start(
      {
        handle: worker,
        clock,
        logger: options.logger ?? silentLogger,
        publish: (event) => published.push(event),
        record: (kind, data) => recorded.push([kind, data]),
        onActivity: () => void activity.count++,
        onExit: (exit) => exits.push(exit),
      },
      INIT,
    );
    if (!options.neverReady) worker.emit({ ...READY, sessionFile: options.sessionFile ?? "/f" });
    return { clock, published, recorded, exits, activity, worker, live, pi };
  };

import {
  AUTOMATION_LIMITS,
  type AutomationSettings,
  type PrecheckOutcome as PrecheckWire,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Gates } from "./gates.ts";
import { writeJournal } from "./fire-journal.ts";
import type { PrecheckOrigin } from "./precheck-queue.ts";
import { type AgentBinding, precheckRefusal, precheckWrapOf, releaseEgress } from "./trigger-agent.ts";
import type { TriggerRecord } from "./triggers.ts";

/** What a precheck is given: its command, the saved folder, the names of the daemon variables it keeps (owner m10q7), who asked. */
export interface PrecheckInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: readonly string[];
  readonly triggerId: string;
  readonly origin: PrecheckOrigin;
  /** Aborted: the command is killed through the ladder (a feed poll past its deadline, Task 10). */
  readonly signal?: AbortSignal;
  /** An agent trigger's sandbox (M11R68): the command runs as `[bwrap, ...argv]`, never in a plain shell. */
  readonly wrap?: (command: string) => string[];
  /** The sandbox has network, through the agent's own proxy socket: the command gets pap's proxy variables (decision 90). */
  readonly proxied?: boolean;
}
/**
 * What the port answers: the contract's outcome and a `detail` of ours. A skip's detail is the first line of its output,
 * stripped; an error's is one of the fixed `precheck …` texts (M10R70). The detail never reaches an RPC answer for a skip.
 */
export type PrecheckRun = PrecheckWire & { readonly detail?: string };
/** Runs a precheck command (Task 9). Its output is untrusted: it reaches the model only inside a fence. */
export interface PrecheckPort {
  run(input: PrecheckInput): Promise<PrecheckRun>;
  /** `automation.stop()`: running prechecks are aborted, waiting ones are dropped. */
  stop?(): void;
}

const ERRORED = "precheck error";

/** Runs the precheck, or says it could not: a throw is logged and answered as an error, never lost. */
export async function runPrecheck(
  deps: { readonly logger: Logger; readonly precheck?: PrecheckPort },
  input: PrecheckInput,
): Promise<PrecheckRun | null> {
  if (!deps.precheck) return null;
  try {
    const outcome = await deps.precheck.run(input);
    return { ...outcome, output: outcome.output.slice(0, AUTOMATION_LIMITS.precheckOutputBytes) };
  } catch (error) {
    deps.logger.warn("precheck_failed", { err: error });
    return { verdict: "error", exitCode: null, durationMs: 0, output: "", detail: ERRORED };
  }
}

export type PrecheckStep =
  | { readonly kind: "go"; readonly precheck: string | null }
  | {
      readonly kind: "stop";
      readonly verdict: "precheck" | "error";
      /** What the journal line says. */
      readonly detail: string;
      /** The closed code a manual fire answers with. */
      readonly answer: string;
    };

export interface PrecheckStepDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly gates: Pick<Gates, "over">;
  readonly triggers: { resolveFolder(cwd: string): string };
  readonly precheck?: PrecheckPort;
  /** The agents' ports (M11): an agent trigger's precheck runs in the agent's sandbox. */
  readonly agents?: AgentBinding;
}

export interface PrecheckHow {
  readonly source: "schedule" | "manual" | "feed";
  /** The daily budget gates this fire (a schedule, a token's manual fire). */
  readonly gated: boolean;
  readonly origin: PrecheckOrigin;
  readonly signal?: AbortSignal;
}

/**
 * The precheck before a fire (C §6.4, M10R70). It runs AFTER the pause and the budget: a fire those would refuse is handed
 * on without a precheck, so the fire path refuses it and writes its own line, and no command is ever spawned for it. A skip
 * or an error is journaled here (the journal collapses repeats); a pass hands the output on to be fenced.
 */
export function createPrecheckStep(deps: PrecheckStepDeps) {
  function journal(
    record: TriggerRecord,
    how: PrecheckHow,
    verdict: "precheck" | "error",
    detail: string,
  ): void {
    deps.db.transaction(() =>
      writeJournal(deps.db, {
        triggerId: record.id,
        ownerId: record.ownerId,
        source: how.source,
        verdict,
        detail: detail === "" ? null : detail,
        taskId: null,
        dedupKey: null,
        at: deps.clock.now(),
      }),
    );
  }

  function stop(
    record: TriggerRecord,
    how: PrecheckHow,
    verdict: "precheck" | "error",
    detail: string,
    answer: string,
  ) {
    journal(record, how, verdict, detail);
    return { kind: "stop", verdict, detail, answer } as const;
  }

  return {
    async run(record: TriggerRecord, how: PrecheckHow): Promise<PrecheckStep> {
      const command = record.input?.execution.precheck ?? null;
      if (command === null || !deps.precheck) return { kind: "go", precheck: null };
      if (deps.settings.automation(record.ownerId).paused) return { kind: "go", precheck: null };
      // A paused agent's fire is refused by the fire path (M11R75): no command is spawned for it.
      const agent =
        record.agentId === null ? null : deps.agents?.ports()?.registry.get(record.ownerId, record.agentId);
      if (agent && (agent.paused || agent.quarantinedAt !== null)) return { kind: "go", precheck: null };
      if (how.gated && deps.gates.over(record.ownerId, record.id)) return { kind: "go", precheck: null };
      let cwd: string;
      let wrap: ((command: string) => string[]) | undefined;
      let release: (() => Promise<void>) | undefined;
      let proxied = false;
      try {
        // An agent's home is inside pap's own folder, which `resolveFolder` refuses; its sandbox opens it instead.
        cwd = record.agentId === null ? deps.triggers.resolveFolder(record.cwd) : record.cwd;
        if (record.agentId !== null)
          ({ wrap, release, proxied } = await precheckWrapOf(deps.agents, record.ownerId, record.agentId));
      } catch (error) {
        // Never an unsandboxed run: an unusable sandbox is the precheck's own error, named by the gate's own word.
        const code = precheckRefusal(error);
        return stop(record, how, "error", code, code);
      }
      let outcome: PrecheckRun | null;
      try {
        outcome = await runPrecheck(deps, {
          command,
          cwd,
          env: record.input?.execution.env ?? [],
          triggerId: record.id,
          origin: how.origin,
          signal: how.signal,
          ...(wrap ? { wrap, proxied } : {}),
        });
      } finally {
        // The command's proxy socket ends with it, a spawn failure included (M11R243).
        await releaseEgress(release, deps.logger);
      }
      if (outcome === null || outcome.verdict === "pass")
        return { kind: "go", precheck: outcome?.output ?? null };
      if (outcome.verdict === "skip")
        return stop(record, how, "precheck", outcome.detail ?? "", `exit ${outcome.exitCode ?? "?"}`);
      const detail = outcome.detail ?? ERRORED;
      return stop(record, how, "error", detail, detail);
    },
  };
}
export type PrecheckRunner = ReturnType<typeof createPrecheckStep>;

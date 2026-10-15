import { labelValue } from "./labels.ts";
import type { RunRow } from "./store.ts";

type Scrub = (text: string) => { count: number };

/**
 * One ended run as a `logs/runs.jsonl` line (M10R87). The file goes to Loki, so it is built key by key from ids, counts
 * and money, never from an event or a row spread: no prompt, text, path or tool argument can reach it. Every string is a
 * plain label (`labelValue`: ASCII, no quote, line break or secret format, 64 characters at most) and the rest are
 * numbers or closed enums, so a value cannot start a second line and the line stays well under 1 KiB.
 */
export function runLine(run: RunRow, scrub: Scrub): string {
  if (run.endedAt === null) throw new Error("only an ended run is exported");
  const label = (raw: string): string => labelValue(raw, scrub);
  const line = {
    v: 1,
    ts: new Date(run.endedAt).toISOString(),
    id: label(run.id),
    ownerId: label(run.ownerId),
    sessionId: label(run.sessionId),
    taskId: run.taskId === null ? null : label(run.taskId),
    origin: label(run.origin),
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: Math.max(0, run.endedAt - run.startedAt),
    provider: labelValue(run.provider, scrub),
    model: labelValue(run.model, scrub),
    billing: run.billing,
    tokens: {
      input: run.inputTokens,
      output: run.outputTokens,
      cacheRead: run.cacheReadTokens,
      cacheWrite: run.cacheWriteTokens,
    },
    costUsd: run.costUsd,
    turns: run.turns,
    toolCalls: run.toolCalls,
    errorClass: run.errorClass,
    limitResetAt: run.limitResetAt,
  };
  return JSON.stringify(line);
}

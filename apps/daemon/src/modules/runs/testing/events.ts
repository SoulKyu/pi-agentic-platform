import type { PiEvent } from "@pap/contracts";

export interface UsageInput {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
}

const usageOf = (usage: UsageInput) => ({
  input: usage.input ?? 0,
  output: usage.output ?? 0,
  cacheRead: usage.cacheRead ?? 0,
  cacheWrite: usage.cacheWrite ?? 0,
  totalTokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost ?? 0 },
});

/** An assistant `message_end` as Pi emits it. */
export const assistantEnd = (
  usage: UsageInput,
  extra: { provider?: string; model?: string; stopReason?: string; errorMessage?: string } = {},
): PiEvent => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    provider: extra.provider ?? "anthropic",
    model: extra.model ?? "claude-sonnet",
    stopReason: extra.stopReason ?? "stop",
    ...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
    usage: usageOf(usage),
  },
});

export const compactionEnd = (
  result: { usage?: UsageInput } | undefined,
  extra: Record<string, unknown> = {},
): PiEvent => ({
  type: "compaction_end",
  reason: "threshold",
  aborted: result === undefined,
  willRetry: false,
  result:
    result === undefined
      ? undefined
      : {
          summary: "s",
          firstKeptEntryId: "e",
          tokensBefore: 1,
          ...(result.usage ? { usage: usageOf(result.usage) } : {}),
        },
  ...extra,
});

export const toolStart = (nested = false): PiEvent => ({
  type: "tool_execution_start",
  toolCallId: "c1",
  toolName: "bash",
  args: {},
  ...(nested ? { parentToolCallId: "p1" } : {}),
});

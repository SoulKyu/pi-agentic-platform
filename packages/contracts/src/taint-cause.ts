import { z } from "zod";
import { INVISIBLE, ToolName } from "./policy.ts";

/** The most causes a card names (the worker keeps the newest ones and counts the older). */
export const MAX_TAINT_CAUSES = 8;

/**
 * What tainted a session (decision 117, A3): the tool whose result was external, its registered source exactly as Pi
 * reports it (`ToolInfo.sourceInfo.path`), when (ms since the epoch) and whether the owner could declare it local
 * (`LocalToolRule`): true only for an extension tool that took the unknown fallback, never a built-in, MCP, platform,
 * sandbox, codemode or tool-search tool.
 */
export const TaintCause = z
  .object({
    tool: ToolName,
    source: z
      .string()
      .min(1)
      .max(1024)
      .refine((source) => !INVISIBLE.test(source), "a source is one line of visible characters"),
    /** The newest result of this tool and source in the taint epoch. */
    at: z.number().int().nonnegative(),
    /** How many results of this tool and source tainted (one entry per pair, so a chatty tool uses one slot). */
    count: z.number().int().positive(),
    markable: z.boolean(),
  })
  .strict();
export type TaintCause = z.infer<typeof TaintCause>;
/**
 * The causes a card carries: the newest 8 distinct (tool, source) pairs, newest last, and how many older pairs were
 * dropped. When any cause was not markable, or any was dropped, every entry says `markable: false` (decision 117, APR-8).
 */
export const TaintCauses = z
  .object({
    list: z.array(TaintCause).max(MAX_TAINT_CAUSES),
    older: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();
export type TaintCauses = z.infer<typeof TaintCauses>;

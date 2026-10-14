import { createHash } from "node:crypto";
import { PrefixRule, ToolRule } from "@pap/contracts";
import { z } from "zod";

export type RuleKind = "exact" | "prefix" | "tool";

/** What a prefix or tool rule covers, as the policy module takes it (Task 2b, M7R23). */
export type PatternRule =
  | { readonly kind: "prefix"; readonly prefix: readonly string[] }
  | { readonly kind: "tool"; readonly source: ToolRule["source"] };

const ToolPattern = z.object({ source: ToolRule.shape.source }).strict();

/** The `pattern` column of a rule. */
export const patternText = (rule: PatternRule): string =>
  JSON.stringify(rule.kind === "prefix" ? rule.prefix : { source: rule.source });

/** The unique key of a pattern rule: the sha256 of [tool, kind, pattern] (M7R23). */
export const patternKey = (tool: string, rule: PatternRule): string =>
  createHash("sha256")
    .update(JSON.stringify([tool, rule.kind, rule.kind === "prefix" ? rule.prefix : { source: rule.source }]))
    .digest("hex");

/** Whether a rule is one the worker can be given: the tool and the pattern pass the same schemas as at storage. */
export function validPattern(tool: string, rule: PatternRule): boolean {
  if (rule.kind === "prefix") return tool === "bash" && PrefixRule.safeParse({ prefix: rule.prefix }).success;
  return tool !== "bash" && ToolRule.safeParse({ tool, source: rule.source }).success;
}

const parsed = (pattern: string | null): unknown => {
  if (pattern === null) return null;
  try {
    return JSON.parse(pattern);
  } catch {
    return null;
  }
};

/** A stored prefix row as a rule, or null when it no longer parses as one. */
export function readPrefix(row: { tool: string; pattern: string | null }): PrefixRule | null {
  const rule = PrefixRule.safeParse({ prefix: parsed(row.pattern) });
  return rule.success && row.tool === "bash" ? rule.data : null;
}

/** A stored tool row as a rule, or null when it no longer parses as one. */
export function readTool(row: { tool: string; pattern: string | null }): ToolRule | null {
  const pattern = ToolPattern.safeParse(parsed(row.pattern));
  if (!pattern.success) return null;
  const rule = ToolRule.safeParse({ tool: row.tool, source: pattern.data.source });
  return rule.success && row.tool !== "bash" ? rule.data : null;
}

import { INVISIBLE, TaintCause, ToolName } from "@pap/contracts";
import type { TaintCauseFacts } from "./taint.ts";
import { isMarkableSource, type ToolFacts, type ToolKind } from "./tool-kind.ts";

const UNKNOWN_SOURCE = "unknown";
const MAX_SOURCE = 1024;

/** A source as one visible line within the contract's bound: a card that the schema refuses would never reach the owner. */
function sourceOf(path: string | undefined): string {
  const visible = (path ?? "").replace(new RegExp(INVISIBLE.source, "gu"), "").slice(0, MAX_SOURCE);
  return visible.length === 0 ? UNKNOWN_SOURCE : visible;
}

/**
 * Decision 117, A3: what to record when the result of `tool` raises the taint. `markable` only for the tool's own external
 * classification of the unknown fallback from a source a `LocalToolRule` can name (`isMarkableSource`): a built-in, MCP,
 * platform, sandbox, codemode or tool-search tool never is, and neither is a call external only because of its parent.
 * Whatever throws or does not fit the contract is recorded as not markable: the cause is never what stops a result.
 */
export function taintCauseOf(
  tool: string,
  classify: (name: string) => ToolKind,
  facts: ((name: string) => ToolFacts | undefined) | undefined,
): TaintCauseFacts {
  let markable: boolean;
  let path: string | undefined;
  try {
    path = facts?.(tool)?.path;
    const kind = classify(tool);
    markable = path !== undefined && isMarkableSource(path) && kind.category === "unknown" && kind.external;
  } catch {
    markable = false;
  }
  const name = ToolName.safeParse(tool).success ? tool : tool.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 64);
  const source = sourceOf(path);
  const cause = {
    tool: name.length > 0 ? name : "_",
    source,
    markable: markable && name === tool && source === path,
  };
  return TaintCause.omit({ at: true, count: true }).safeParse(cause).success
    ? cause
    : { tool: "_", source: UNKNOWN_SOURCE, markable: false };
}

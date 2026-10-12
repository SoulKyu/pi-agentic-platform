import type { ToolCategory } from "@pap/contracts";

/** What Pi records about a registered tool (`ToolInfo.sourceInfo.path` and the tool's own hints). */
export interface ToolFacts {
  readonly path: string;
  readonly readOnlyHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

export interface ToolKind {
  readonly category: ToolCategory;
  /** The tool reaches outside the machine or returns outside content: its result is fenced and taints (stage 07). */
  readonly external: boolean;
  /** Its input may carry a URL the egress stage must judge. */
  readonly urlBearing: boolean;
  readonly mcp: boolean;
  /** Pi's own built-in of that name, not an extension that took the name over. */
  readonly builtin: boolean;
}

const BUILTIN_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  edit: "edit",
  write: "edit",
  bash: "exec",
  powershell: "exec",
  web_fetch: "network",
  web_search: "network",
  fetch: "network",
};
const URL_BEARING = new Set<ToolCategory>(["exec", "network"]);

/** M5R116. Names are matched exactly; the registration decides whether the name is Pi's own. */
export function classifyTool(name: string, facts: ToolFacts | undefined): ToolKind {
  const category = Object.hasOwn(BUILTIN_CATEGORY, name) ? BUILTIN_CATEGORY[name] : undefined;
  if (category !== undefined && facts?.path === `builtin:${name}`)
    return {
      category,
      external: category === "network",
      urlBearing: URL_BEARING.has(category),
      mcp: false,
      builtin: true,
    };
  return {
    category: "unknown",
    external: facts?.openWorldHint !== false,
    urlBearing: true,
    mcp: false,
    builtin: false,
  };
}

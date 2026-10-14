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
  /** Pi's own codemode tool (by registered source): its result can carry a value an earlier script stored (`store`/`load`). */
  readonly codemode?: true;
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
/** `ToolInfo.sourceInfo.path` of the tools Pi's own MCP, codemode and tool-search extensions register (recorded by `host.mcp.int.test.ts` and `host.builtins.int.test.ts`). */
export const MCP_SOURCE = "builtin:mcp";
export const CODEMODE_SOURCE = "builtin:codemode";
export const TOOL_SEARCH_SOURCE = "builtin:tool-search";
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
]);
// `mcp__<server>__<tool>`: Pi maps every other character of both names to `_`.
const MCP_TOOL_NAME = /^mcp__\w+?__\w+$/;
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
  const extension = extensionKind(name, facts);
  if (extension) return extension;
  return {
    category: "unknown",
    external: facts?.openWorldHint !== false,
    urlBearing: true,
    mcp: false,
    builtin: false,
  };
}

/**
 * M5R24. Only the registration by Pi's own extension makes a name MCP, codemode or tool search: an extension that
 * claims one of these names is an ordinary unknown tool and gets no read-only status from the hint it declares.
 * The hints of an MCP tool are its server author's unverified claim: only a boolean `readOnlyHint` counts, and every
 * MCP tool is external whatever `openWorldHint` says (an HTTP server receives every argument; `ToolInfo` carries no
 * transport). `openWorldHint: false` keeps its meaning for other extension tools only (MQ2).
 * Wiring (`builtins.ts`, loaded by `open-session.ts`): the MCP, codemode and tool-search extensions are registered as
 * `{ name: "mcp" | "codemode" | "tool-search", factory, builtin: true, replaceable: true }` with exactly those names;
 * a bare factory gets `<inline:N>` and its tools would classify as unknown and external.
 */
function extensionKind(name: string, facts: ToolFacts | undefined): ToolKind | null {
  const pure = { external: false, urlBearing: false, mcp: false, builtin: false } as const;
  if (facts?.path === CODEMODE_SOURCE && name === "codemode")
    return { category: "read", ...pure, codemode: true };
  if (facts?.path === TOOL_SEARCH_SOURCE && name === "tool_search") return { category: "read", ...pure };
  if (facts?.path !== MCP_SOURCE) return null;
  if (MCP_RESOURCE_TOOLS.has(name))
    return { category: "read", external: true, urlBearing: true, mcp: true, builtin: false };
  if (!MCP_TOOL_NAME.test(name)) return null;
  return {
    category: facts.readOnlyHint === true ? "read" : "external-write",
    external: true,
    urlBearing: true,
    mcp: true,
    builtin: false,
  };
}

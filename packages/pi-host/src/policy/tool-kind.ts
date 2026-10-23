import {
  type LocalToolRule,
  PLATFORM_OPS,
  type PlatformOp,
  type ToolCategory,
  type WhenTainted,
} from "@pap/contracts";

/** What Pi records about a registered tool (`ToolInfo.sourceInfo.path` and the tool's own hints). */
export interface ToolFacts {
  readonly path: string;
  readonly readOnlyHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
  /** Whether the session's sandbox has network; only the policy extension sets it, from the VM session, and only a `bash` from `SANDBOX_SOURCE` reads it. */
  readonly sandboxNetwork?: boolean | undefined;
  /** The worker's policy config has `vm`; only the policy extension sets it, and only `read`/`write`/`edit`/`ls` from `VM_FILES_SOURCE` read it. */
  readonly vm?: boolean | undefined;
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
  /** A tool of pap's own platform extension (M11R13): the op it calls and what a tainted session gets. */
  readonly platform?: { readonly op: PlatformOp; readonly whenTainted: WhenTainted };
  /** pap's own sandboxed `bash` (M11R25, by registered source): a command like Pi's `bash` (`builtin` stays false, so Task 5 can tell the two apart). */
  readonly sandboxed?: true;
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
/** `ToolInfo.sourceInfo.path` of the tools pi-host's inline `pap-platform` extension registers (pinned by `host.platform.int.test.ts`). */
export const PLATFORM_SOURCE = "<inline:pap-platform>";
/** `ToolInfo.sourceInfo.path` of the `bash` pi-host's inline `pap-sandbox` extension registers (pinned by `host.sandbox.int.test.ts`). */
export const SANDBOX_SOURCE = "<inline:pap-sandbox>";
/** `ToolInfo.sourceInfo.path` of the `read`, `write`, `edit` and `ls` pi-host's inline `pap-vm-files` extension registers in a VM session (R26). */
export const VM_FILES_SOURCE = "<inline:pap-vm-files>";
const VM_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "ls"]);
const PLATFORM_OP_OF_TOOL: ReadonlyMap<string, PlatformOp> = new Map(
  (Object.keys(PLATFORM_OPS) as PlatformOp[]).map((op) => [PLATFORM_OPS[op].tool, op]),
);
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
]);
// `mcp__<server>__<tool>`: Pi maps every other character of both names to `_`.
const MCP_TOOL_NAME = /^mcp__\w+?__\w+$/;
const URL_BEARING = new Set<ToolCategory>(["exec", "network"]);

/**
 * Whether a registered source can be declared local (decision 117, A2): `builtin:*` (Pi's own tools, MCP, codemode,
 * tool search) and `<inline:*>` (pap's platform and sandbox extensions) are reserved, whatever name a rule gives them.
 */
export const isMarkableSource = (path: string): boolean =>
  !path.startsWith("builtin:") && !path.startsWith("<inline:");

/** M5R116. Names are matched exactly; the registration decides whether the name is Pi's own. */
export function classifyTool(
  name: string,
  facts: ToolFacts | undefined,
  localTools: readonly LocalToolRule[] = [],
): ToolKind {
  const category = Object.hasOwn(BUILTIN_CATEGORY, name) ? BUILTIN_CATEGORY[name] : undefined;
  // R26: pap's VM file tools are Pi's own definitions over pap's operations: classified like the built-in, in a VM worker only.
  const vmFiles = facts?.path === VM_FILES_SOURCE && facts.vm === true && VM_FILE_TOOLS.has(name);
  if (category !== undefined && (facts?.path === `builtin:${name}` || vmFiles))
    return {
      category,
      external: category === "network",
      urlBearing: URL_BEARING.has(category),
      mcp: false,
      builtin: true,
    };
  const extension = extensionKind(name, facts);
  if (extension) return extension;
  // Last, and never from a reserved source, so a rule cannot reclassify a built-in, MCP, platform, sandbox, codemode or
  // tool-search tool, nor a name those sources left unknown (decision 117, A2).
  if (
    facts &&
    isMarkableSource(facts.path) &&
    localTools.some((rule) => rule.tool === name && rule.source === facts.path)
  )
    return { category: "read", external: false, urlBearing: false, mcp: false, builtin: false };
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
  if (facts?.path === PLATFORM_SOURCE) return platformKind(name);
  if (facts?.path === SANDBOX_SOURCE) return sandboxKind(name, facts);
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

/** M11R13: only a name of the op table, from the platform source, is a platform tool; any other name from it is unknown (fail closed). */
function platformKind(name: string): ToolKind | null {
  const op = PLATFORM_OP_OF_TOOL.get(name);
  if (op === undefined) return null;
  return {
    category: "read",
    external: false,
    urlBearing: false,
    mcp: false,
    builtin: false,
    platform: { op, whenTainted: PLATFORM_OPS[op].whenTainted },
  };
}

/**
 * M11R25 (W5-R9): only `bash` from the sandbox source, in a worker whose init record declared a sandbox, is the sandboxed
 * shell. `external` follows its network: a shell with none reaches nothing outside the machine (like Pi's `bash`), a
 * networked one can fetch anything and taints its thread at its first result. Anything else from the source is unknown.
 */
function sandboxKind(name: string, facts: ToolFacts): ToolKind | null {
  if (name !== "bash" || facts.sandboxNetwork === undefined) return null;
  return {
    category: "exec",
    external: facts.sandboxNetwork,
    urlBearing: true,
    mcp: false,
    builtin: false,
    sandboxed: true,
  };
}

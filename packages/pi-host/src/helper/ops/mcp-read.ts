import { join } from "node:path";
import {
  type CodemodeView,
  HELPER_OPS,
  type McpFileProblem,
  type McpFileView,
  type McpServerView,
  MCP_LIMITS,
  type McpOverview,
} from "@pap/contracts";
import { maskMcpEntry } from "../mcp-entry.ts";
import { PiFileRefused, readPiFile } from "../pi-file.ts";
import { defineOp, type HelperContext } from "../ops.ts";
import { readCodemodeState } from "./codemode-settings.ts";
import { isTrusted } from "./models-open.ts";

/** What one file's view may weigh (two files and the codemode line stay under the daemon's 900 000 byte page). */
export const MCP_VIEW_BYTES_MAX = 400_000;

type Entries = ReadonlyArray<readonly [string, unknown]>;
type Loaded =
  | { readonly problem: McpFileProblem }
  | { readonly entries: Entries; readonly autoEnable: boolean | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Names that differ only by `-` and `_` share a namespace in Pi's tool names. */
const namespace = (name: string): string => name.replaceAll("-", "_");

/**
 * One `mcp.json` as Pi reads it: `JSON.parse` of the text (no comments, no BOM: what Pi refuses is `unparsable` here too).
 * The file goes through `readPiFile` (real path inside `roots`, regular file, at most 1 MiB, no FIFO waited on). Any other
 * failure to read it (a permission, say) is `not-a-file`: the overview names a file it cannot read, never the reason.
 */
async function load(path: string, roots: readonly string[]): Promise<Loaded | "missing"> {
  let text: string | null;
  try {
    text = (await readPiFile(path, roots)).text;
  } catch (error) {
    if (error instanceof PiFileRefused)
      return { problem: error.reason === "hard-link" ? "not-a-file" : error.reason };
    return { problem: "not-a-file" };
  }
  if (text === null) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "unparsable" };
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
    return { problem: "invalid-shape" };
  const entries = isRecord(parsed.mcpServers) ? Object.entries(parsed.mcpServers) : [];
  if (entries.length > MCP_LIMITS.servers) return { problem: "too-many-servers" };
  return {
    entries,
    autoEnable: typeof parsed.autoEnableCodemode === "boolean" ? parsed.autoEnableCodemode : undefined,
  };
}

/** The entries as views, in file order; a name that shares a namespace with an earlier valid one is `invalid`. */
function viewsOf(
  entries: Entries,
  scope: McpServerView["scope"],
  taken: Map<string, string>,
): McpServerView[] {
  return entries.map(([name, raw]) => {
    const view = maskMcpEntry(name, raw, scope);
    if (view.kind === "invalid") return view;
    const holder = taken.get(namespace(name));
    if (holder !== undefined && holder !== name)
      return { ...view, kind: "invalid", state: "invalid", problem: "name-collision" };
    taken.set(namespace(name), name);
    return view;
  });
}

const fileView = (
  path: string,
  trusted: boolean | null,
  loaded: Loaded | "missing",
  servers: McpServerView[],
): McpFileView => {
  const problem = typeof loaded === "object" && "problem" in loaded ? loaded.problem : null;
  const view = { path, problem, trusted, servers: problem === null ? servers : [] };
  if (Buffer.byteLength(JSON.stringify(view)) <= MCP_VIEW_BYTES_MAX) return view;
  return { path, problem: "too-large", trusted, servers: [] };
};

/** Which override keys the project entry sets: an override changes only those (the SDK merges them over the global entry). */
const overrideKeys = (entries: Entries, name: string): Record<string, unknown> => {
  const raw = entries.find(([key]) => key === name)?.[1];
  return isRecord(raw) ? raw : {};
};

/**
 * Both files, read only (M7R82): no process starts, no URL is opened, no `${VAR}` or `!command` is resolved. A project's
 * servers count (`replaced`, `overridden`) only while its trust decision is `true` (M7R85); otherwise they are listed
 * `not-trusted` and change nothing. The project file is read within the session folder's real path only (M7R84).
 */
export async function readMcpFiles(
  ctx: Pick<HelperContext, "agentDir" | "home" | "cwd">,
): Promise<McpOverview> {
  const globalPath = join(ctx.agentDir, "mcp.json");
  const globalLoaded = await load(globalPath, [ctx.agentDir, ctx.home]);
  const taken = new Map<string, string>();
  const globalEntries =
    typeof globalLoaded === "object" && "entries" in globalLoaded ? globalLoaded.entries : [];
  const globalServers = viewsOf(globalEntries, "global", taken);

  let projectView: McpFileView | null = null;
  let projectAuto: boolean | undefined;
  let trusted = false;
  if (ctx.cwd !== undefined) {
    trusted = isTrusted(ctx.agentDir, ctx.cwd);
    const path = join(ctx.cwd, ".pi", "mcp.json");
    const loaded = await load(path, [ctx.cwd]);
    const entries = typeof loaded === "object" && "entries" in loaded ? loaded.entries : [];
    if (typeof loaded === "object" && "autoEnable" in loaded) projectAuto = loaded.autoEnable;
    // Pi never reads an untrusted file, so its names collide with nothing.
    const servers = viewsOf(entries, "project", trusted ? taken : new Map());
    for (const [index, view] of servers.entries()) {
      if (view.kind === "invalid") continue;
      if (!trusted) {
        servers[index] = { ...view, state: "not-trusted" };
        continue;
      }
      // Matched on the raw names of the files, in file order: a displayed name is never a key.
      const rawName = entries[index]?.[0];
      const at = globalServers.findIndex(
        (candidate, i) => globalEntries[i]?.[0] === rawName && candidate.kind !== "invalid",
      );
      const base = globalServers[at];
      if (view.kind === "override" && base === undefined) {
        servers[index] = { ...view, kind: "invalid", state: "invalid", problem: "no-base" };
      } else if (base !== undefined) {
        if (view.kind === "override") {
          const set = overrideKeys(entries, rawName ?? "");
          globalServers[at] = {
            ...base,
            state: "overridden",
            ...("enabled" in set ? { enabled: view.enabled } : {}),
            ...("exposure" in set ? { exposure: view.exposure } : {}),
            ...("toolExposure" in set ? { toolExposureCount: view.toolExposureCount } : {}),
          };
        } else globalServers[at] = { ...base, state: "replaced" };
      }
    }
    projectView = fileView(path, trusted, loaded, servers);
  }

  const globalAuto =
    typeof globalLoaded === "object" && "autoEnable" in globalLoaded ? globalLoaded.autoEnable : undefined;
  const codemode: CodemodeView =
    trusted && projectAuto !== undefined
      ? { autoEnable: projectAuto, source: "project" }
      : globalAuto !== undefined
        ? { autoEnable: globalAuto, source: "global" }
        : { autoEnable: true, source: "default" };
  const state = await readCodemodeState(ctx);
  return {
    global: fileView(globalPath, null, globalLoaded, globalServers),
    project: projectView,
    codemode,
    settings: state.settings,
    codemodeBuiltinOff: state.builtinOff,
  };
}

export const mcpOverviewOp = defineOp({
  params: HELPER_OPS["mcp.overview"].params,
  run: (_params, ctx) => readMcpFiles(ctx),
});

import { offline } from "./offline.ts";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createMcpExtension,
  type ExtensionUIContext,
  type McpServerConfig,
  type McpServerEntry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { HELPER_OPS } from "@pap/contracts";
import type { z } from "zod";
import { ANSI_THEME } from "../../ansi-theme.ts";
import { closeSession } from "../../shutdown.ts";
import { maskMcpEntry, McpEntry, RESERVED_NAMES } from "../mcp-entry.ts";
import { entryOf, hasEntry, isRecord, McpFileInvalid, parseMcpDoc } from "../mcp-file.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { PiFileRefused, readPiFile } from "../pi-file.ts";
import { classifyTestOutcome } from "./mcp-test-outcome.ts";
import { isTrusted, openRuntime } from "./models-open.ts";

type Params = z.infer<(typeof HELPER_OPS)["mcp.test"]["params"]>;
type Ctx = Pick<HelperContext, "agentDir" | "home" | "cwd" | "signal">;

/** What the extension may tell before the answer is classified: a few notices, each clipped (they can carry a server's text). */
export const NOTICES_MAX = 16;
export const NOTICE_CHARS = 2048;
/**
 * The shutdown gets this long to stop the server. pi-mcp starts each stdio server in a group of its own, so the pool's
 * group signals never reach it: the helper's main sweeps its descendants on exit, SIGTERM, SIGHUP and a closed channel.
 */
const SHUTDOWN_GRACE_MS = 3_000;

export interface TestRun {
  readonly notices: string[];
  /** Pi's names for the server's tools, without the `mcp__<server>__` prefix. */
  readonly tools: string[];
  readonly timedOut: boolean;
}

/** The entry as the file holds it, read through the same guard as every Pi file (links, size, hard links). */
async function readEntry(params: Params, ctx: Ctx): Promise<McpServerEntry> {
  if (RESERVED_NAMES.has(params.name)) throw new HelperOpError("bad_params", "name");
  if (params.scope === "project") {
    if (ctx.cwd === undefined) throw new HelperOpError("bad_params", "cwd");
    // Testing runs the repository's command: only a project whose trust decision is `true` (M7R94).
    if (!isTrusted(ctx.agentDir, ctx.cwd)) throw new HelperOpError("project_untrusted");
  }
  const path =
    params.scope === "global" ? join(ctx.agentDir, "mcp.json") : join(ctx.cwd ?? "", ".pi", "mcp.json");
  const roots = params.scope === "global" ? [ctx.agentDir, ctx.home] : [ctx.cwd ?? ""];
  let raw: unknown;
  try {
    const doc = parseMcpDoc((await readPiFile(path, roots)).text);
    if (!hasEntry(doc, params.name)) throw new HelperOpError("not_found", "entry");
    raw = entryOf(doc, params.name);
  } catch (error) {
    if (error instanceof PiFileRefused)
      throw new HelperOpError(
        error.reason === "hard-link" ? "config_hard_link" : "config_path_refused",
        error.reason,
      );
    if (error instanceof McpFileInvalid) throw new HelperOpError("config_invalid", "mcp.json");
    throw error;
  }
  // The entry rules of the overview: what Pi cannot load is not run (no transport, a bad URL, `sse`, a project `auth`).
  const parsed = isRecord(raw) ? McpEntry.safeParse(raw) : null;
  const view = maskMcpEntry(params.name, raw, params.scope);
  if (parsed === null || !parsed.success || view.kind === "invalid" || view.kind === "override")
    throw new HelperOpError("bad_params", "entry");
  // A Test connects the server whatever the file says about `enabled`, and its tools are declared directly: no codemode or
  // tool search is needed to see them, and a per-tool override cannot hide one.
  const loose = { ...parsed.data, enabled: true, exposure: "direct" };
  delete loose.toolExposure;
  const config = loose as unknown as McpServerConfig;
  return { name: params.name, config, source: path, scope: params.scope };
}

/** A UI that keeps the warnings and errors of the extension and answers every dialog with nothing. */
function noticeUi(keep: (message: string) => void): ExtensionUIContext {
  const nothing = async (): Promise<undefined> => undefined;
  return {
    select: nothing,
    confirm: async () => false,
    input: nothing,
    editor: nothing,
    notify: (message, type) => {
      if (type === "warning" || type === "error") keep(message);
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: nothing as unknown as ExtensionUIContext["custom"],
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: ANSI_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are not supported in a Test." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

/** Keeps a few warnings and errors, each clipped; the rest are dropped. */
export function createNoticeKeeper() {
  const notices: string[] = [];
  return {
    notices,
    keep(message: string): void {
      if (notices.length < NOTICES_MAX) notices.push(message.slice(0, NOTICE_CHARS));
    },
  };
}

/** What a handler that threw tells instead of its text (a rejected `/mcp` is a failure, never a connection). */
export const HANDLER_FAILED_NOTICE = "The MCP extension reported an error.";

/** True when `work` finished first; false at the deadline, at once when the run is already cancelled, or when it is cancelled. */
export async function within(
  ms: number,
  signal: AbortSignal,
  work: Promise<unknown>,
  keep: (message: string) => void,
): Promise<boolean> {
  work.catch(() => {});
  if (signal.aborted) return false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => {
          keep(HANDLER_FAILED_NOTICE);
          return true;
        },
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
        onAbort = () => resolve(false);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs what the file says for one server in a throwaway session (M7R93): no extension, skill, prompt template, theme or
 * context file of the user's, no coding tool, an in-memory session, and Pi's own MCP extension over that one entry. It waits
 * for the server's connection (its tools or a notice) up to the deadline, then closes the session, which stops the server.
 * The server runs with the helper's environment (the daemon's minus `PAP_*`, `NODE_OPTIONS` and the service manager's
 * variables, like a worker's) and the entry's own `env`. Its stderr is never read here.
 */
export async function runServerTest(params: Params, ctx: Ctx): Promise<TestRun> {
  const entry = await readEntry(params, ctx);
  const cwd = ctx.cwd ?? ctx.home;
  const { notices, keep } = createNoticeKeeper();
  // Only the resource load is offline (MC52); the server under test keeps its own network.
  const modelRuntime = await openRuntime(ctx);
  const services = await offline(() =>
    createAgentSessionServices({
      cwd,
      agentDir: ctx.agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // A bare factory: with `noExtensions` a `builtin:mcp` path would not load, and a factory always does.
        extensionFactories: [
          createMcpExtension({
            loadConfig: () => ({ servers: [entry], errors: [] }),
            openUrl: () => {},
            startupWaitMs: 0,
          }),
        ],
      },
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
    }),
  );
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
  });
  try {
    await session.bindExtensions({
      uiContext: noticeUi(keep),
      mode: "rpc",
      onError: () => keep(HANDLER_FAILED_NOTICE),
    });
    // Outside a terminal `/mcp` waits for the connections, then reports them: the same wait a session's first `/mcp` does.
    const command = session.extensionRunner.getCommand("mcp");
    if (!command) throw new HelperOpError("failed", "mcp command");
    const finished = await within(
      params.deadlineMs,
      ctx.signal,
      command.handler("", session.extensionRunner.createCommandContext()),
      keep,
    );
    const prefix = `mcp__${params.name}__`.replace(/[^A-Za-z0-9_]/g, "_");
    const tools = session
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("mcp__"))
      .map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : name));
    return { notices, tools, timedOut: !finished };
  } finally {
    await closeSession(session, SHUTDOWN_GRACE_MS);
    session.dispose();
  }
}

export const mcpTestOp = defineOp({
  params: HELPER_OPS["mcp.test"].params,
  run: async (params, ctx) => {
    const { notices, tools, timedOut } = await runServerTest(params, ctx);
    return classifyTestOutcome(notices, tools, timedOut);
  },
});

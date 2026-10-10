import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  Theme,
  VERSION,
  type AgentSession,
  type ExtensionUIContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { moveInlinePolicyLast, probeExtensions, probeLog, type ProbeOrder } from "./probe-extensions.ts";
import { buildFaux, loadScript } from "./scripted.ts";

interface Init { type: "init"; cwd: string; agentDir: string; script: string; order: ProbeOrder; builtins: boolean; sessionFile?: string; sessionId?: string }
type Inbound =
  | Init
  | { type: "prompt"; id: string; message: string }
  | { type: "get_tree"; id: string }
  | { type: "navigate_tree"; id: string; targetId: string }
  | { type: "custom_input"; id: string; data: string }
  | { type: "probe_report"; id: string }
  | { type: "shutdown" };

class PlainTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }
  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
}

const started = performance.now();
const send = (record: object) => process.send?.(record);
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const panels = new Map<string, (data: string) => void>();
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = new PlainTheme();
let session: AgentSession | null = null;
let extensionPaths: string[] = [];
// R10: when does Pi first write the session JSONL? Logged on every size change, checked synchronously per event.
const sessionFileLog: Array<{ after: string; bytes: number | null; entries?: string[] }> = [];
function noteSessionFile(after: string): void {
  const file = session?.sessionFile;
  const bytes = file && existsSync(file) ? statSync(file).size : null;
  const previous = sessionFileLog.at(-1);
  if (previous && previous.bytes === bytes) return;
  const firstWrite = file && bytes !== null && (previous?.bytes ?? null) === null;
  const entries = firstWrite
    ? readFileSync(file, "utf8").trim().split("\n").map((line) => {
        const entry = JSON.parse(line) as { type: string; message?: { role: string } };
        return entry.message ? `${entry.type}:${entry.message.role}` : entry.type;
      })
    : undefined;
  sessionFileLog.push({ after, bytes, ...(entries ? { entries } : {}) });
}

function uiContext(): ExtensionUIContext {
  const custom = <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
    new Promise<T>((resolve) => {
      const id = randomUUID();
      let component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void } | null = null;
      const render = () => { if (component) send({ type: "custom_render", id, lines: component.render(92) }); };
      const tui = { terminal: { columns: 92, rows: 40, kittyProtocolActive: false }, requestRender: render };
      const done = (value: unknown) => {
        panels.delete(id);
        component?.dispose?.();
        component = null; // handleInput may call done(): no render after custom_close
        send({ type: "custom_close", id });
        resolve(value as T);
      };
      // The SDK's KeybindingsManager subclass (app bindings) is exported as a type only: pass the TUI one, as pi-web does.
      void Promise.resolve(factory(tui as never, theme, keybindings as never, done)).then((created) => {
        component = created;
        panels.set(id, (data) => { created.handleInput?.(data); render(); });
        render();
      });
    });
  return {
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => undefined,
    notify: (message: string, notifyType?: string) =>
      send({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType }),
    custom,
    theme,
  } as unknown as ExtensionUIContext;
}

async function boot(init: Init): Promise<void> {
  const faux = buildFaux(loadScript(init.script));
  const modelRuntime = await ModelRuntime.create({ authPath: join(init.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const builtins: InlineExtension[] = init.builtins ? [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()] : [];
  const services = await createAgentSessionServices({
    cwd: init.cwd,
    agentDir: init.agentDir,
    modelRuntime,
    settingsManager: SettingsManager.create(init.cwd, init.agentDir),
    resourceLoaderOptions: {
      extensionFactories: [...builtins, ...probeExtensions(init.order)],
      ...(init.order === "override-last" ? { extensionsOverride: moveInlinePolicyLast } : {}),
    },
  });
  extensionPaths = services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
  // R10 probe: `sessionId` asks to recreate a never-written file under its old id instead of opening the missing path.
  const sessionManager = !init.sessionFile
    ? SessionManager.create(init.cwd)
    : init.sessionId && !existsSync(init.sessionFile)
      ? SessionManager.create(init.cwd, dirname(init.sessionFile), { id: init.sessionId })
      : SessionManager.open(init.sessionFile);
  session = (await createAgentSessionFromServices({ services, sessionManager, model: faux.model })).session;
  session.subscribe((event) => {
    const nested = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
    const role = (event as { message?: { role?: string } }).message?.role;
    noteSessionFile([event.type, nested?.type ?? role].filter(Boolean).join(":"));
    send(nested ? { type: event.type, assistantMessageEvent: { type: nested.type, delta: nested.delta } } : event);
  });
  await session.bindExtensions({ uiContext: uiContext(), mode: "rpc" });
  noteSessionFile("ready");
  send({ type: "ready", sessionFile: session.sessionFile, sessionId: session.sessionId, piVersion: VERSION, importedAtMs: Math.round(started), readyMs: Math.round(performance.now() - started), rssMb: rssMb() });
}

process.on("message", (raw: Inbound) => {
  if (raw.type === "init") { boot(raw).catch((error: unknown) => send({ type: "boot_error", error: String(error) })); return; }
  if (raw.type === "custom_input") { panels.get(raw.id)?.(raw.data); return; }
  if (raw.type === "shutdown") { session?.dispose(); process.exit(0); }
  if (!session) return;
  const current = session;
  if (raw.type === "prompt") {
    current
      .prompt(raw.message, { preflightResult: (disposition) => send({ type: "response", id: raw.id, data: { disposition } }) })
      .catch((error: unknown) => send({ type: "response", id: raw.id, error: String(error) }));
  } else if (raw.type === "get_tree") {
    send({ type: "response", id: raw.id, data: { tree: current.sessionManager.getTree(), leafId: current.sessionManager.getLeafId(), rssMb: rssMb() } });
  } else if (raw.type === "navigate_tree") {
    void current.navigateTree(raw.targetId, { summarize: false }).then((result) => send({ type: "response", id: raw.id, data: result }));
  } else if (raw.type === "probe_report") {
    send({ type: "response", id: raw.id, data: { probeLog, extensionPaths, sessionFileLog } });
  }
});

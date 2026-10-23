import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type InlineExtension,
  ModelRuntime,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { InitRecord, PolicyAuditEntry, PolicyRules } from "@pap/contracts";
import { agentPrompt } from "./agent-prompt.ts";
import type { Approvals } from "./approvals.ts";
import { messageOf } from "./bounded.ts";
import { piBuiltins, signInNotifier } from "./builtins.ts";
import type { Outbound } from "./ipc.ts";
import { createLoadoutWatcher, rememberProjectTrust } from "./loadout.ts";
import { shellFactsOf } from "./shell-facts.ts";
import { createPresetKeeper } from "./tool-preset-commands.ts";
import { applyPreset, pinToolAllowlist, presetOf, withPreset } from "./tool-presets.ts";
import type { SecretReader } from "./policy/secrets.ts";
import { createPapPolicyExtension, movePolicyLast, type PolicyConfig } from "./policy/extension.ts";
import { UNTRUSTED_RULE } from "./policy/fence.ts";
import type { Taint } from "./policy/taint.ts";
import { createPlatformTools, platformFirst, type PlatformPort } from "./platform-tools.ts";
import { createVmFileTools, vmFilesFirst } from "./vm-files/extension.ts";
import { realVmRoots } from "./policy/vm-paths.ts";
import type { ShellEnvironment } from "./shell-env.ts";
import { createVmShellTool, vmShellFirst } from "./vm-shell/tool.ts";
import { appendMemoryTrust } from "./memory-entry.ts";
import { applyRelayKey } from "./relay-key.ts";
import { loadScriptedProvider } from "./scripted-provider.ts";
import type { UiBridge } from "./ui-bridge.ts";

export interface ExtensionErrorReport {
  extensionPath: string;
  event: string;
  error: string;
}

export interface OpenSessionDeps {
  readonly ui: UiBridge;
  /** The policy's own questions; only the policy extension asks through it. */
  readonly approvals: Approvals;
  rules(): PolicyRules | null;
  /** Moves on every policy update (the host bumps it), valid or not. */
  rulesVersion(): number;
  /** The session's taint (stage 07). */
  readonly taint: Taint;
  audit(entry: PolicyAuditEntry): void;
  /** The secrets the worker knows (stage 06). */
  readonly secrets: SecretReader;
  /** The VM shell's vault values and one-use values (ADR 0081); none: the shell gets no secret. */
  readonly shellEnvironment?: Pick<ShellEnvironment, "envFor">;
  /** Told the active tool names at each `agent_start` (the session entry, M5R15). */
  onAgentStart?(activeToolNames: string[]): void;
  onEvent(event: AgentSessionEvent): void;
  onExtensionError(error: ExtensionErrorReport): void;
  /** Where the loadout record goes when an extension switches the model or the level (M7R44); none: the watcher is not installed. */
  readonly sendLoadout?: (record: Outbound) => unknown;
  /** The way to the daemon for the platform tools of `init.platform.ops`; absent (tests), every call is answered `unavailable`. */
  readonly platform?: PlatformPort;
  /** Inline extensions that load next to the policy and the Pi built-ins (the policy always runs last): tests. */
  readonly extraExtensions?: readonly InlineExtension[];
  /** Builds the policy extension. Only tests replace it, to prove that a session never starts without it. */
  readonly createPolicy?: (config: PolicyConfig) => ReturnType<typeof createPapPolicyExtension>;
}

const UNAVAILABLE: PlatformPort = { call: async () => ({ ok: false, error: "unavailable" }) };
const TRUST_EXTENSION_PATH = "<pap:project-trust>";

// Pi's own default is fail open (`projectTrusted: true`) and `reload()` never asks again, so pap decides here, and
// every failure of the store (unreadable or corrupt file, a held lock, a read-only agent directory) means untrusted.
// `trusted()` is the last answer, which the loadout tells the daemon (M7R105).
function projectTrustResolver(
  agentDir: string,
  cwd: string,
  report: OpenSessionDeps["onExtensionError"],
  neverTrusted: boolean,
) {
  let reported = false;
  let trusted = false;
  return {
    resolve: async (): Promise<boolean> => {
      // W5-R29: an agent writes its own home, so no trust Pi's store holds (the CLI's, an ancestor's) opens its project resources.
      if (neverTrusted) return false;
      try {
        trusted = new ProjectTrustStore(agentDir).get(cwd) === true;
      } catch (error) {
        trusted = false;
        if (!reported) {
          reported = true;
          report({ extensionPath: TRUST_EXTENSION_PATH, event: "project_trust", error: messageOf(error) });
        }
      }
      return trusted;
    },
    trusted: () => trusted,
  };
}

// A folder whose files cannot be looked at is asked about, like the trust dialog does (M7R107).
function requiresTrust(cwd: string): boolean {
  try {
    return hasTrustRequiringProjectResources(cwd);
  } catch {
    return true;
  }
}

// Pi derives the session directory from PI_CODING_AGENT_DIR, not from the agent directory it is given: a worker
// whose environment disagrees would write its sessions somewhere other than where its init record says.
function requireAgentDirEnv(agentDir: string): void {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (!fromEnv || resolve(fromEnv) !== resolve(agentDir)) {
    throw new Error("PI_CODING_AGENT_DIR must name the agent directory of the init record");
  }
}

/** The prompt's facts (M11R55): the home is the VM's (RT-06), its network the agent's switch (AVM2-E11), else `$PAP_HOME/agents/<id>`; the scratch folder is the rules'. */
function agentFactsOf(init: InitRecord, scratch: string | null, vmNetwork: boolean) {
  const { agent, papHome, vm } = init;
  return {
    name: agent?.name ?? "",
    home: vm?.layout.home ?? join(papHome, "agents", agent?.id ?? ""),
    role: agent?.role ?? "",
    network: vm ? vmNetwork : null,
    scratch,
  };
}

/** R28: a new VM session is created in the layout's sessions folder, which the mirror reads. */
export const sessionDirOf = (init: InitRecord): string | undefined => init.vm?.layout.sessions;

export async function openSession(init: InitRecord, deps: OpenSessionDeps): Promise<AgentSession> {
  const { cwd, agentDir, papHome } = init;
  requireAgentDirEnv(agentDir);
  const preset = init.tools?.preset ?? "configured";
  // Chat only (M7R74): no extension, skill or prompt template of the user's, and none of the built-ins below. The inline
  // factories (pap-policy first of all) still load; movePolicyLast refuses to start the session without the policy.
  const chat = preset === "chat";
  const platformOps = init.platform?.ops ?? [];
  if (init.testProviderScript && process.env.PAP_TEST_PROVIDER !== "1") {
    throw new Error("a test provider script needs PAP_TEST_PROVIDER=1 in the worker environment");
  }
  // A VM session's file roots, real folders checked once: a root that is a link stops the worker (R26).
  const vmNetwork = init.vm !== undefined && deps.rules()?.sandbox?.network === true;
  const vm = init.vm ? { layout: init.vm.layout, roots: await realVmRoots(init.vm.layout) } : undefined;
  const scripted = init.testProviderScript ? await loadScriptedProvider(init.testProviderScript) : null;
  let modelRuntime: ModelRuntime | undefined;
  if (scripted) {
    modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      // The worker's own file, like production: a test can add a provider to it and see a warm worker refresh (MPR25).
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(scripted.provider);
  }
  // The loadout watcher asks for the session when an event comes; Pi builds it below.
  const created: { session?: AgentSession } = {};
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const showSignInLink = signInNotifier((message, type) => deps.ui.context.notify(message, type));
  const shell = () => shellFactsOf(settingsManager, process.env);
  // The worker's own preset is part of what the policy judges with, from the first call (M7R78).
  const presetNow = () => (created.session ? presetOf(created.session) : preset);
  const policy = (deps.createPolicy ?? createPapPolicyExtension)({
    rules: () => withPreset(deps.rules(), presetNow(), init.tools?.allowlist ?? null),
    rulesVersion: deps.rulesVersion,
    taint: deps.taint,
    audit: deps.audit,
    secrets: deps.secrets,
    // R15: pap's shell is the only shell of a VM session; its network is the agent's switch, fixed at open (AVM2-E11):
    // the shell, the taint of its results and the prompt all read the same `vmNetwork`.
    ...(vm ? { vm, sandbox: { network: vmNetwork } } : {}),
    ...(deps.onAgentStart ? { onAgentStart: deps.onAgentStart } : {}),
    agentDir,
    papHome,
    sessionId: () => init.papSessionId,
    home: homedir(),
    shell,
    ask: (request, signal) => deps.approvals.ask(request, signal),
  });
  const platformOrder = platformFirst(deps.onExtensionError);
  const vmOrder = vm
    ? { files: vmFilesFirst(deps.onExtensionError), shell: vmShellFirst(deps.onExtensionError) }
    : undefined;
  const trust = projectTrustResolver(agentDir, cwd, deps.onExtensionError, init.agent !== undefined);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      ...(chat ? { noExtensions: true, noSkills: true, noPromptTemplates: true } : {}),
      // W5-R24: an agent session reads no AGENTS.md / CLAUDE.md. Pi loads them from the agent folder, the cwd and every
      // parent whatever the trust, and the thread's home is its cwd and agent-writable: a file written once would join
      // every later system prompt unfenced. pap's own agent prompt is the only instruction source; owner sessions keep Pi's.
      ...(init.agent ? { agentsFilesOverride: () => ({ agentsFiles: [] }) } : {}),
      // Listed first on purpose: movePolicyLast puts the policy last, so the guarantee does not rest on how Pi orders
      // its extension sources.
      extensionFactories: [
        policy,
        ...(chat ? [] : piBuiltins({ showSignInLink })),
        createPresetKeeper(() => created.session),
        // pap's `bash` and file tools in the VM; an owner session keeps Pi's own.
        ...(init.vm && vm
          ? [
              createVmShellTool(init.vm, {
                redact: () => deps.secrets.current(),
                network: vmNetwork,
                ...(deps.shellEnvironment ? { environment: deps.shellEnvironment } : {}),
              }),
              createVmFileTools(vm.roots, cwd),
            ]
          : []),
        // Loaded in every preset (inline factories always load, M7R74); `applyPreset` decides whether the model sees them.
        ...(platformOps.length > 0
          ? [
              createPlatformTools(
                platformOps,
                deps.platform ?? UNAVAILABLE,
                () => deps.rules()?.autonomy != null,
              ),
            ]
          : []),
        ...(deps.sendLoadout ? [createLoadoutWatcher(deps.sendLoadout, () => created.session)] : []),
        ...(deps.extraExtensions ?? []),
      ],
      extensionsOverride: (base) => {
        const ordered = platformOrder(base);
        return movePolicyLast(vmOrder ? vmOrder.files(vmOrder.shell(ordered)) : ordered);
      },
      // Once, at session creation: Pi's session files do not store the system prompt (M5R42).
      appendSystemPromptOverride: (base) => [
        ...base,
        UNTRUSTED_RULE,
        ...(init.agent
          ? [agentPrompt(agentFactsOf(init, deps.rules()?.agentScratch ?? null, vmNetwork))]
          : []),
        ...(init.child ? [init.child.prompt] : []),
      ],
    },
    resourceLoaderReloadOptions: {
      resolveProjectTrust: trust.resolve,
    },
  });
  // RT-03: in a VM every provider's key is the launch's relay key; the credentials stay on the host.
  if (init.vm)
    await applyRelayKey(
      services.modelRuntime,
      init.vm.relayKey,
      services.modelRuntime.getProviders().map((p) => p.id),
    );
  const sessionManager = init.sessionFile
    ? SessionManager.open(init.sessionFile)
    : SessionManager.create(cwd, sessionDirOf(init));
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(scripted ? { model: scripted.model } : {}),
  });
  created.session = session;
  rememberProjectTrust(session, { required: requiresTrust(cwd), trusted: trust.trusted() });
  // At once: from here the policy reads the worker's preset from the session, and no extension has run yet.
  pinToolAllowlist(session, init.tools?.allowlist);
  applyPreset(session, preset);
  session.subscribe((event) => deps.onEvent(event));
  // M11R142: pi-mem0 reads its profile entry at `session_start`, which `bindExtensions` emits.
  if (init.memory) appendMemoryTrust(sessionManager, init.memory);
  await session.bindExtensions({
    uiContext: deps.ui.context,
    mode: "rpc",
    onError: (error) =>
      deps.onExtensionError({
        extensionPath: error.extensionPath,
        event: error.event,
        error: error.error,
      }),
  });
  // Extensions may have changed the active tools while they started (MCP activates codemode and tool_search).
  applyPreset(session, preset);
  return session;
}

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
import type { Approvals } from "./approvals.ts";
import { messageOf } from "./bounded.ts";
import { piBuiltins, signInNotifier } from "./builtins.ts";
import type { Outbound } from "./ipc.ts";
import { createLoadoutWatcher, rememberProjectTrust } from "./loadout.ts";
import { shellFactsOf } from "./shell-facts.ts";
import { createPresetKeeper } from "./tool-preset-commands.ts";
import { applyPreset, pinToolAllowlist, presetOf, withPreset } from "./tool-presets.ts";
import type { SecretSource } from "./policy/secrets.ts";
import { createPapPolicyExtension, movePolicyLast, type PolicyConfig } from "./policy/extension.ts";
import { UNTRUSTED_RULE } from "./policy/fence.ts";
import type { Taint } from "./policy/taint.ts";
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
  readonly secrets: SecretSource;
  /** Told the active tool names at each `agent_start` (the session entry, M5R15). */
  onAgentStart?(activeToolNames: string[]): void;
  onEvent(event: AgentSessionEvent): void;
  onExtensionError(error: ExtensionErrorReport): void;
  /** Where the loadout record goes when an extension switches the model or the level (M7R44); none: the watcher is not installed. */
  readonly sendLoadout?: (record: Outbound) => unknown;
  /** Inline extensions that load next to the policy and the Pi built-ins (the policy always runs last): tests. */
  readonly extraExtensions?: readonly InlineExtension[];
  /** Builds the policy extension. Only tests replace it, to prove that a session never starts without it. */
  readonly createPolicy?: (config: PolicyConfig) => ReturnType<typeof createPapPolicyExtension>;
}

const TRUST_EXTENSION_PATH = "<pap:project-trust>";

// Pi's own default is fail open (`projectTrusted: true`) and `reload()` never asks again, so pap decides here, and
// every failure of the store (unreadable or corrupt file, a held lock, a read-only agent directory) means untrusted.
// `trusted()` is the last answer, which the loadout tells the daemon (M7R105).
function projectTrustResolver(agentDir: string, cwd: string, report: OpenSessionDeps["onExtensionError"]) {
  let reported = false;
  let trusted = false;
  return {
    resolve: async (): Promise<boolean> => {
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

export async function openSession(init: InitRecord, deps: OpenSessionDeps): Promise<AgentSession> {
  const { cwd, agentDir, papHome } = init;
  requireAgentDirEnv(agentDir);
  const preset = init.tools?.preset ?? "configured";
  // Chat only (M7R74): no extension, skill or prompt template of the user's, and none of the built-ins below. The inline
  // factories (pap-policy first of all) still load; movePolicyLast refuses to start the session without the policy.
  const chat = preset === "chat";
  if (init.testProviderScript && process.env.PAP_TEST_PROVIDER !== "1") {
    throw new Error("a test provider script needs PAP_TEST_PROVIDER=1 in the worker environment");
  }
  const scripted = init.testProviderScript ? await loadScriptedProvider(init.testProviderScript) : null;
  let modelRuntime: ModelRuntime | undefined;
  if (scripted) {
    modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
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
    ...(deps.onAgentStart ? { onAgentStart: deps.onAgentStart } : {}),
    agentDir,
    papHome,
    sessionId: () => init.papSessionId,
    home: homedir(),
    shell,
    ask: (request, signal) => deps.approvals.ask(request, signal),
  });
  const trust = projectTrustResolver(agentDir, cwd, deps.onExtensionError);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      ...(chat ? { noExtensions: true, noSkills: true, noPromptTemplates: true } : {}),
      // Listed first on purpose: movePolicyLast puts the policy last, so the guarantee does not rest on how Pi orders
      // its extension sources.
      extensionFactories: [
        policy,
        ...(chat ? [] : piBuiltins({ showSignInLink })),
        createPresetKeeper(() => created.session),
        ...(deps.sendLoadout ? [createLoadoutWatcher(deps.sendLoadout, () => created.session)] : []),
        ...(deps.extraExtensions ?? []),
      ],
      extensionsOverride: movePolicyLast,
      // Once, at session creation: Pi's session files do not store the system prompt (M5R42).
      appendSystemPromptOverride: (base) => [...base, UNTRUSTED_RULE],
    },
    resourceLoaderReloadOptions: {
      resolveProjectTrust: trust.resolve,
    },
  });
  const sessionManager = init.sessionFile
    ? SessionManager.open(init.sessionFile)
    : SessionManager.create(cwd);
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

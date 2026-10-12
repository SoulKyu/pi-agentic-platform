import { join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type InlineExtension,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { InitRecord, PolicyAuditEntry, PolicyRules } from "@pap/contracts";
import type { Approvals } from "./approvals.ts";
import { messageOf } from "./bounded.ts";
import type { SecretSource } from "./policy/secrets.ts";
import { createPapPolicyExtension, movePolicyLast, type PolicyConfig } from "./policy/extension.ts";
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
  audit(entry: PolicyAuditEntry): void;
  /** The secrets the worker knows (stage 06). */
  readonly secrets?: SecretSource;
  /** Told the active tool names at each `agent_start` (the session entry, M5R15). */
  onAgentStart?(activeToolNames: string[]): void;
  onEvent(event: AgentSessionEvent): void;
  onExtensionError(error: ExtensionErrorReport): void;
  /** Inline extensions that load next to the policy (it always runs after them): the Pi built-ins, and tests. */
  readonly extraExtensions?: readonly InlineExtension[];
  /** Builds the policy extension. Only tests replace it, to prove that a session never starts without it. */
  readonly createPolicy?: (config: PolicyConfig) => ReturnType<typeof createPapPolicyExtension>;
}

const TRUST_EXTENSION_PATH = "<pap:project-trust>";

// Pi's own default is fail open (`projectTrusted: true`) and `reload()` never asks again, so pap decides here, and
// every failure of the store (unreadable or corrupt file, a held lock, a read-only agent directory) means untrusted.
function projectTrustResolver(agentDir: string, cwd: string, report: OpenSessionDeps["onExtensionError"]) {
  let reported = false;
  return async (): Promise<boolean> => {
    try {
      return new ProjectTrustStore(agentDir).get(cwd) === true;
    } catch (error) {
      if (!reported) {
        reported = true;
        report({ extensionPath: TRUST_EXTENSION_PATH, event: "project_trust", error: messageOf(error) });
      }
      return false;
    }
  };
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
  const policy = (deps.createPolicy ?? createPapPolicyExtension)({
    rules: deps.rules,
    rulesVersion: deps.rulesVersion,
    audit: deps.audit,
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
    ...(deps.onAgentStart ? { onAgentStart: deps.onAgentStart } : {}),
    agentDir,
    papHome,
    ask: (request, signal) => deps.approvals.ask(request, signal),
  });
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      // Listed first on purpose: movePolicyLast puts the policy last, so the guarantee does not rest on how Pi orders
      // its extension sources.
      extensionFactories: [policy, ...(deps.extraExtensions ?? [])],
      extensionsOverride: movePolicyLast,
    },
    resourceLoaderReloadOptions: {
      resolveProjectTrust: projectTrustResolver(agentDir, cwd, deps.onExtensionError),
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
  return session;
}

import type { HelperCode } from "@pap/contracts/pi-host";
import type { z } from "zod";
import { subagentProfileOp } from "./ops/agent-profile.ts";
import { subagentProfilesOp } from "./ops/agent-profiles.ts";
import { loginOp, logoutOp, setApiKeyOp } from "./ops/auth.ts";
import { mcpCodemodeOp } from "./ops/codemode-settings.ts";
import { mcpOverviewOp } from "./ops/mcp-read.ts";
import { mcpTestOp } from "./ops/mcp-test.ts";
import {
  mcpAddOp,
  mcpRemoveOp,
  mcpRestoreOp,
  mcpSetEnabledOp,
  mcpSetExposureOp,
  mcpSetInProjectOp,
} from "./ops/mcp-write.ts";
import { modelsAvailableOp } from "./ops/models-available.ts";
import { setEnabledOp } from "./ops/enabled-models.ts";
import { refreshCatalogDefinition } from "./ops/models-catalog.ts";
import { setDefaultOp, setDefaultThinkingOp } from "./ops/models-defaults.ts";
import { modelsDiscoverOp, modelsTestOp } from "./ops/models-discover.ts";
import { configGetOp, configSaveOp } from "./ops/models-json.ts";
import { providerGetOp, providerRemoveOp, providerSaveOp } from "./ops/models-provider.ts";
import { modelsExtensionsOp } from "./ops/models-extensions.ts";
import { modelsOverviewOp } from "./ops/models-overview.ts";
import { modelsPricingOp } from "./ops/models-pricing.ts";
import { modelsUsageOp } from "./ops/models-usage.ts";
import { ping } from "./ops/ping.ts";
import {
  pluginsInstallOp,
  pluginsListOp,
  pluginsRemoveOp,
  pluginsSetEnabledOp,
  pluginsUpdateOp,
} from "./ops/plugins.ts";
import { pluginsResolveOp } from "./ops/plugins-resolve.ts";
import { templateWriteOp } from "./ops/prompt-template.ts";
import { skillsInstallOp } from "./ops/skills-install.ts";
import { skillsSearchOp } from "./ops/skills-search.ts";
import { skillsListOp, skillsSetInvocationOp } from "./ops/skills.ts";
import { testOps } from "./ops/testing.ts";
import { trustSetOp, trustStatusOp } from "./ops/trust.ts";

export interface HelperContext {
  readonly agentDir: string;
  readonly papHome: string;
  readonly home: string;
  readonly cwd?: string;
  /** Aborted when the daemon cancels the run; an op that waits on something long watches it. */
  readonly signal: AbortSignal;
  /** Sends one event to whoever started the run. Throws when the record is over the bound. */
  emit(event: unknown): void;
  /** Asks the person behind the run; `null` when they declined or the run was cancelled. */
  prompt(prompt: unknown): Promise<string | null>;
}

export interface HelperOp<P, R> {
  readonly params: z.ZodType<P>;
  run(params: P, ctx: HelperContext): Promise<R>;
}

/** What the table holds: the params are parsed by `params` before `run` sees them (see `executeOp`). */
export interface ErasedOp {
  readonly params: z.ZodType<unknown>;
  run(params: unknown, ctx: HelperContext): Promise<unknown>;
}
export type OpTable = Readonly<Record<string, ErasedOp>>;

export function defineOp<P, R>(op: HelperOp<P, R>): ErasedOp {
  return { params: op.params, run: (params, ctx) => op.run(params as P, ctx) };
}

/** An op failing on purpose: the code reaches the daemon, the detail only its log (clipped). */
export class HelperOpError extends Error {
  readonly code: HelperCode;
  constructor(code: HelperCode, detail?: string) {
    super(detail ?? code);
    this.name = "HelperOpError";
    this.code = code;
  }
}

/** The test-only ops exist only when the daemon was started for tests (`PAP_TEST_PROVIDER=1`). */
export const opsFor = (env: NodeJS.ProcessEnv): OpTable => ({
  ping: defineOp(ping),
  "models.overview": modelsOverviewOp,
  "models.available": modelsAvailableOp,
  "models.setDefault": setDefaultOp,
  "models.setDefaultThinking": setDefaultThinkingOp,
  "models.setEnabled": setEnabledOp,
  "models.refreshCatalog": refreshCatalogDefinition,
  "models.config.get": configGetOp,
  "models.config.save": configSaveOp,
  "models.provider.get": providerGetOp,
  "models.provider.save": providerSaveOp,
  "models.provider.remove": providerRemoveOp,
  "models.discover": modelsDiscoverOp,
  "models.test": modelsTestOp,
  "models.pricing": modelsPricingOp,
  "models.extensions": modelsExtensionsOp,
  "models.usage": modelsUsageOp,
  "auth.login": loginOp,
  "auth.setApiKey": setApiKeyOp,
  "auth.logout": logoutOp,
  "mcp.overview": mcpOverviewOp,
  "mcp.setEnabled": mcpSetEnabledOp,
  "mcp.setExposure": mcpSetExposureOp,
  "mcp.setInProject": mcpSetInProjectOp,
  "mcp.remove": mcpRemoveOp,
  "mcp.restore": mcpRestoreOp,
  "mcp.add": mcpAddOp,
  "mcp.codemode": mcpCodemodeOp,
  "mcp.test": mcpTestOp,
  "trust.status": trustStatusOp,
  "trust.set": trustSetOp,
  "skills.list": skillsListOp,
  "skills.setInvocation": skillsSetInvocationOp,
  "skills.search": skillsSearchOp,
  "skills.install": skillsInstallOp,
  "plugins.list": pluginsListOp,
  "plugins.resolve": pluginsResolveOp,
  "plugins.install": pluginsInstallOp,
  "plugins.remove": pluginsRemoveOp,
  "plugins.update": pluginsUpdateOp,
  "plugins.setEnabled": pluginsSetEnabledOp,
  "templates.write": templateWriteOp,
  "subagents.profiles": subagentProfilesOp,
  "subagents.profile": subagentProfileOp,
  ...(env.PAP_TEST_PROVIDER === "1" ? testOps : {}),
});

export const OPS: OpTable = Object.freeze(opsFor(process.env));

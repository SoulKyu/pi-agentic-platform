import { z } from "zod";
import type { ErrorCode } from "./errors.ts";
import {
  CodemodeSettings,
  McpOverview,
  McpRemoveHelperResult,
  McpSetEnabledResult,
  McpTestHelperParams,
  McpTestOutcome,
  McpWriteParams,
} from "./mcp-methods.ts";
import {
  ConfigGetHelperParams,
  ConfigGetResult,
  ConfigSaveHelperParams,
  ConfigSaveResult,
} from "./models-config.ts";
import {
  DiscoverParams,
  ModelsDiscoverResult,
  HelperPricingResult,
  ModelsTestResult,
  PricingParams,
  TestModelParams,
} from "./models-provider.ts";
import {
  LoginParams,
  LogoutParams,
  ModelsOverview,
  SetApiKeyParams,
  SetDefaultThinkingParams,
  SetDefaultParams,
  SetEnabledParams,
  SetEnabledResult,
  RefreshCatalogResult,
} from "./models-methods.ts";
import {
  PluginSourceParams,
  PluginSetEnabledParams,
  PluginSetEnabledResult,
  PluginsListResult,
  PluginUpdateParams,
  PluginUpdateResult,
  SkillsInstallParams,
  SkillsListResult,
  SkillsSearchParams,
  SkillsSearchResult,
  SkillsSetInvocationParams,
  SkillsSetInvocationResult,
} from "./skills-methods.ts";
import { TrustSetHelperParams, TrustSetHelperResult, TrustStatus } from "./trust-methods.ts";

const AbsolutePath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");
const PromptId = z.string().min(1).max(64);

/** Per run: the daemon kills a helper past any of these, and the helper refuses to send past the record bound. */
export const HELPER_MAX_EVENTS = 256;
export const HELPER_MAX_PROMPTS = 16;
export const HELPER_MAX_RECORD_BYTES = 1024 * 1024;

/** The first and only run record: one operation per helper process (ADR 0023). */
export const HelperRun = z
  .object({
    type: z.literal("helper_run"),
    op: z.string().min(1).max(64),
    agentDir: AbsolutePath,
    papHome: AbsolutePath,
    /** The project folder the operation is about (trust, project files, project skills). */
    cwd: AbsolutePath.optional(),
    params: z.unknown(),
  })
  .strict();
export type HelperRun = z.infer<typeof HelperRun>;
export const DaemonToHelper = z.discriminatedUnion("type", [
  HelperRun,
  z
    .object({
      type: z.literal("helper_answer"),
      promptId: PromptId,
      value: z.string().max(65_536).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("helper_cancel") }).strict(),
]);
export type DaemonToHelper = z.infer<typeof DaemonToHelper>;

export const HELPER_CODES = [
  "bad_params",
  "unknown_op",
  "not_found",
  "conflict",
  "project_scope",
  "project_untrusted",
  "protected_path",
  "config_invalid",
  "config_path_refused",
  "config_hard_link",
  "failed",
] as const;
export type HelperCode = (typeof HELPER_CODES)[number];
// A plain union: two members share `type: "helper_done"` (ok true / false).
export const HelperToDaemon = z.union([
  z.object({ type: z.literal("helper_event"), event: z.unknown() }).strict(),
  z.object({ type: z.literal("helper_prompt"), promptId: PromptId, prompt: z.unknown() }).strict(),
  z.object({ type: z.literal("helper_done"), ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      type: z.literal("helper_done"),
      ok: z.literal(false),
      code: z.enum(HELPER_CODES),
      /** For the daemon's log only, clipped; never sent to a client. */
      detail: z.string().max(256).optional(),
    })
    .strict(),
]);
export type HelperToDaemon = z.infer<typeof HelperToDaemon>;

const HELPER_ERROR_CODES: { readonly [C in HelperCode]: ErrorCode } = {
  bad_params: "bad_request",
  unknown_op: "internal",
  not_found: "not_found",
  conflict: "conflict",
  project_scope: "project_scope",
  project_untrusted: "forbidden",
  protected_path: "protected_path",
  config_invalid: "config_invalid",
  config_path_refused: "config_path_refused",
  config_hard_link: "config_hard_link",
  failed: "helper_failed",
};

/** What a client is told when a helper operation failed with `code`. */
export const helperErrorCode = (code: HelperCode): ErrorCode => HELPER_ERROR_CODES[code];

const NONE = z.object({}).strict();
const Done = z.object({ ok: z.literal(true) }).strict();

/**
 * The operations of Pi's model configuration: the helper parses `params` before it runs, the daemon parses `result`
 * before it hands anything on (a field the schema does not list is refused, so no secret can ride along).
 */
export const HELPER_OPS = {
  "models.overview": { params: NONE, result: ModelsOverview },
  "models.setDefault": { params: SetDefaultParams, result: Done },
  "models.setDefaultThinking": { params: SetDefaultThinkingParams, result: Done },
  "models.setEnabled": { params: SetEnabledParams, result: SetEnabledResult },
  "models.refreshCatalog": { params: NONE, result: RefreshCatalogResult },
  // The models.json editor (Task 12a): the text leaves the helper masked, and a save is refused or answered by revision.
  "models.config.get": { params: ConfigGetHelperParams, result: ConfigGetResult },
  "models.config.save": { params: ConfigSaveHelperParams, result: ConfigSaveResult },
  // Provider discovery, test and pricing (Task 12b): the status class is all that comes back of a failed request.
  "models.discover": { params: DiscoverParams, result: ModelsDiscoverResult },
  "models.test": { params: TestModelParams, result: ModelsTestResult },
  "models.pricing": { params: PricingParams, result: HelperPricingResult },
  // Sign-in (Task 11): the credential goes to auth.json inside the helper and nothing of it comes back.
  "auth.login": { params: LoginParams, result: Done },
  "auth.setApiKey": { params: SetApiKeyParams, result: Done },
  "auth.logout": { params: LogoutParams, result: Done },
  // The MCP overview (Task 17): files only, nothing run, nothing literal in the answer (M7R82, M7R83).
  "mcp.overview": { params: NONE, result: McpOverview },
  // The MCP writes (Task 18). `mcp.remove` answers the entry text for the daemon's undo store; the daemon never forwards it.
  "mcp.setEnabled": { params: McpWriteParams.setEnabled, result: McpSetEnabledResult },
  "mcp.setExposure": { params: McpWriteParams.setExposure, result: Done },
  "mcp.setInProject": { params: McpWriteParams.setInProject, result: Done },
  "mcp.remove": { params: McpWriteParams.remove, result: McpRemoveHelperResult },
  "mcp.restore": { params: McpWriteParams.restore, result: Done },
  "mcp.add": { params: McpWriteParams.add, result: Done },
  "mcp.codemode": { params: McpWriteParams.codemode, result: CodemodeSettings },
  // Test (Task 19): a throwaway session with Pi's MCP extension; the answer is classified and masked inside the helper.
  "mcp.test": { params: McpTestHelperParams, result: McpTestOutcome },
  // Project trust (Task 22): Pi's trust.json through its own store, in the helper only (M7R103); files read, nothing run.
  "trust.status": { params: NONE, result: TrustStatus },
  "trust.set": { params: TrustSetHelperParams, result: TrustSetHelperResult },
  // Skills (Task 24): listed by Pi's loader, the switch edits one frontmatter line, search and install are the owner's clicks.
  "skills.list": { params: NONE, result: SkillsListResult },
  "skills.setInvocation": { params: SkillsSetInvocationParams, result: SkillsSetInvocationResult },
  "skills.search": { params: SkillsSearchParams, result: SkillsSearchResult },
  "skills.install": { params: SkillsInstallParams, result: Done },
  // Pi packages (Task 25): Pi's package manager in the helper; the list runs offline, the others go online only by the owner's click.
  "plugins.list": { params: NONE, result: PluginsListResult },
  "plugins.install": { params: PluginSourceParams, result: Done },
  "plugins.remove": { params: PluginSourceParams, result: Done },
  "plugins.update": { params: PluginUpdateParams, result: PluginUpdateResult },
  "plugins.setEnabled": { params: PluginSetEnabledParams, result: PluginSetEnabledResult },
} as const;

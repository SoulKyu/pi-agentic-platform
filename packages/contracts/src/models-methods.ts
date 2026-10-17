import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ERROR_CODES } from "./errors.ts";
import { Cursor } from "./frames.ts";
import { modelsAvailableMethods } from "./models-available.ts";
import { modelsConfigMethods } from "./models-config.ts";
import { modelsExtensionsMethods } from "./models-extensions.ts";
import { modelsProviderFormMethods } from "./models-provider-form.ts";
import { modelsProviderMethods } from "./models-provider.ts";
import { modelsUsageMethods } from "./models-usage.ts";
import { ModelSummary, ThinkingLevel } from "./session-loadout.ts";

/** Counts Settings › Models stays within; the helper cuts to these and to a byte budget (`truncated`). */
export const MODELS_LIMITS = { providers: 300, models: 2000, warnings: 50 } as const;

/** The most patterns `enabledModels` may hold in what pap reads and writes; a plan needing more is refused, not cut. */
export const ENABLED_PATTERNS_MAX = 256;
export const ENABLED_PATTERN_MAX_LENGTH = 256;

const Cwd = z.string().min(1).max(4096);
const Ok = z.object({ ok: z.literal(true) });

export const ListedModel = ModelSummary.extend({ enabled: z.boolean() }).strict();
export type ListedModel = z.infer<typeof ListedModel>;

/** What Settings knows of a provider's sign-in. Never a key, a token or a command: only which kinds exist (M7R47). */
const ProviderAuth = z
  .object({
    oauthLabel: z.string().max(256).nullable(),
    apiKey: z.boolean(),
    configured: z.boolean(),
    stored: z.enum(["oauth", "api_key"]).nullable(),
    /** `unknown`: pap could not read the file that says (auth.json, or models.json for its providers); never a Pi call. */
    status: z.enum(["known", "unknown"]),
    /** Environment variables Pi reads a key from for this provider: the names and whether each is set, never a value (MC26). */
    env: z.array(z.object({ name: z.string().min(1).max(64), set: z.boolean() }).strict()).max(8),
  })
  .strict();

export const ProviderView = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().max(256),
    origin: z.enum(["builtin", "models.json"]),
    auth: ProviderAuth,
    models: z.array(ListedModel).max(MODELS_LIMITS.models),
    modelsTruncated: z.boolean(),
  })
  .strict();
export type ProviderView = z.infer<typeof ProviderView>;

export const ModelsOverview = z
  .object({
    providers: z.array(ProviderView).max(MODELS_LIMITS.providers),
    defaults: z
      .object({
        provider: z.string().min(1).max(128).nullable(),
        model: z.string().min(1).max(256).nullable(),
        thinkingLevel: ThinkingLevel.nullable(),
      })
      .strict(),
    enabled: z
      .object({
        patterns: z.array(z.string().max(ENABLED_PATTERN_MAX_LENGTH)).max(ENABLED_PATTERNS_MAX).nullable(),
        scope: z.enum(["global", "project"]),
        settingsPath: z.string().max(4096),
        warnings: z.array(z.string().max(300)).max(MODELS_LIMITS.warnings),
      })
      .strict(),
    offline: z.boolean(),
    /** Providers were left out to stay within the count or the byte budget. */
    truncated: z.boolean(),
  })
  .strict();
export type ModelsOverview = z.infer<typeof ModelsOverview>;

export const SetDefaultParams = z
  .object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) })
  .strict();
export const SetDefaultThinkingParams = z.object({ level: ThinkingLevel }).strict();

const ProviderId = z.string().min(1).max(128);
/** One edit of `enabledModels` (M7R54..56): the helper plans it with Pi's own matching and writes the least change. */
export const EnabledOp = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("toggle"),
      provider: ProviderId,
      modelId: z.string().min(1).max(256),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("provider"), provider: ProviderId, enabled: z.boolean() }).strict(),
  z.object({ op: z.literal("prune") }).strict(),
  z.object({ op: z.literal("clear") }).strict(),
  /** `providers`: the ones that were fully enabled before a `models.json` save. */
  z.object({ op: z.literal("resync"), providers: z.array(ProviderId).max(MODELS_LIMITS.providers) }).strict(),
]);
export type EnabledOp = z.infer<typeof EnabledOp>;
export const SetEnabledParams = z.object({ op: EnabledOp }).strict();
/** The list now in `settings.json`; `null`: the key is absent (every model is enabled). */
export const SetEnabledResult = z
  .object({
    patterns: z.array(z.string().max(ENABLED_PATTERN_MAX_LENGTH)).max(ENABLED_PATTERNS_MAX).nullable(),
  })
  .strict();
/** `failedProviders`: ids of the providers asked that did not answer; their error text stays in Pi. */
export const RefreshCatalogResult = z
  .object({
    changed: z.boolean(),
    offline: z.boolean(),
    failedProviders: z.array(z.string().min(1).max(128)).max(MODELS_LIMITS.providers),
  })
  .strict();
export type RefreshCatalogResult = z.infer<typeof RefreshCatalogResult>;

// ---- Provider sign-in and API keys (Task 11) ----

const LoginText = z.string().max(2048);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** M7R58: a link the browser may open: https, or http on a loopback host (a provider's local callback). */
export const LinkUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    } catch {
      return false;
    }
  }, "an https link");
const LoginPromptId = z.string().min(1).max(64);
export const LoginPrompt = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["text", "secret", "manual_code"]),
      message: LoginText,
      placeholder: LoginText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("select"),
      message: LoginText,
      options: z
        .array(
          z
            .object({ id: z.string().min(1).max(128), label: LoginText, description: LoginText.optional() })
            .strict(),
        )
        .min(1)
        .max(32),
    })
    .strict(),
]);
export type LoginPrompt = z.infer<typeof LoginPrompt>;
export const LoginEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth_url"), url: LinkUrl, instructions: LoginText.optional() }).strict(),
  z
    .object({
      kind: z.literal("device_code"),
      userCode: z.string().min(1).max(64),
      verificationUri: LinkUrl,
      expiresInSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("progress"), message: LoginText }).strict(),
  z
    .object({
      kind: z.literal("info"),
      message: LoginText,
      links: z
        .array(z.object({ url: LinkUrl, label: LoginText.optional() }).strict())
        .max(4)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("prompt"), promptId: LoginPromptId, prompt: LoginPrompt }).strict(),
  z.object({ kind: z.literal("done"), ok: z.boolean(), code: z.enum(ERROR_CODES).optional() }).strict(),
]);
export type LoginEvent = z.infer<typeof LoginEvent>;

export const LoginMethod = z.enum(["oauth", "api_key"]);
export type LoginMethod = z.infer<typeof LoginMethod>;
const hasNoControlCharacter = (text: string): boolean =>
  [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
/**
 * An API key as the owner typed it. Pi runs a stored value that starts with `!` as a shell command, so such a key is
 * refused here and again where the credential is written: pap never stores one (owner c3, MC24).
 */
export const ApiKeyValue = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(hasNoControlCharacter, "no control character")
  .refine((key) => !key.startsWith("!"), "a key cannot start with !");
const FlowId = z.string().min(1).max(64);
export const LoginParams = z.object({ provider: ProviderId, method: LoginMethod }).strict();
export const SetApiKeyParams = z.object({ provider: ProviderId, key: ApiKeyValue }).strict();
export const LogoutParams = z.object({ provider: ProviderId }).strict();
export const LoginAnswerParams = z
  .object({ flowId: FlowId, promptId: LoginPromptId, value: z.string().max(8192) })
  .strict();
export const LoginCancelParams = z.object({ flowId: FlowId }).strict();

const CREDENTIAL_WRITE_ERRORS = [
  "not_found",
  "capacity",
  "timeout",
  "helper_failed",
  "config_invalid",
  "config_path_refused",
  "config_hard_link",
] as const;

export const modelsMethods = {
  ...modelsAvailableMethods,
  ...modelsConfigMethods,
  ...modelsExtensionsMethods,
  ...modelsProviderMethods,
  ...modelsProviderFormMethods,
  ...modelsUsageMethods,
  "models.overview": defineMethod({
    name: "models.overview",
    permission: "pi:read",
    idempotent: true,
    // `cwd` must be a folder the caller has a session or project in (M7R50), else `invalid_cwd`.
    params: z.object({ cwd: Cwd.optional() }),
    result: ModelsOverview,
    errors: ["invalid_cwd", "capacity", "timeout", "helper_failed", "config_invalid", "config_path_refused"],
  }),
  "models.setDefault": defineMethod({
    name: "models.setDefault",
    permission: "pi:admin",
    idempotent: false,
    params: SetDefaultParams.extend({ cwd: Cwd.optional() }),
    result: Ok,
    // bad_request: the model is outside the enabled scope. project_scope: a trusted project sets the key itself.
    // timeout: whether the file was written is unknown.
    errors: [
      "bad_request",
      "not_found",
      "invalid_cwd",
      "project_scope",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ],
  }),
  "models.setDefaultThinking": defineMethod({
    name: "models.setDefaultThinking",
    permission: "pi:admin",
    idempotent: false,
    params: SetDefaultThinkingParams.extend({ cwd: Cwd.optional() }),
    result: Ok,
    errors: [
      "invalid_cwd",
      "project_scope",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ],
  }),
  "models.setEnabled": defineMethod({
    name: "models.setEnabled",
    permission: "pi:admin",
    idempotent: false,
    params: SetEnabledParams.extend({ cwd: Cwd.optional() }),
    result: SetEnabledResult,
    errors: [
      "bad_request",
      "not_found",
      "conflict",
      "invalid_cwd",
      "project_scope",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ],
  }),
  "models.refreshCatalog": defineMethod({
    name: "models.refreshCatalog",
    permission: "pi:admin",
    idempotent: false,
    params: z.object({}),
    result: RefreshCatalogResult,
    errors: ["capacity", "timeout", "helper_failed"],
  }),
  "models.login": defineMethod({
    name: "models.login",
    permission: "pi:admin",
    idempotent: false,
    params: LoginParams,
    result: z.object({ flowId: FlowId }),
    // A password step-up is required (owner c3). capacity: two flows for the owner or a full pool; conflict: one for this provider.
    errors: ["step_up_required", "capacity", "conflict", "helper_failed"],
  }),
  "models.loginAnswer": defineMethod({
    name: "models.loginAnswer",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: ["flowId", "promptId"],
    params: LoginAnswerParams,
    result: Ok,
    // not_found: no such flow of the caller, or the prompt is no longer open.
    errors: ["not_found"],
  }),
  "models.loginCancel": defineMethod({
    name: "models.loginCancel",
    permission: "pi:admin",
    idempotent: false,
    params: LoginCancelParams,
    result: Ok,
    errors: ["not_found"],
  }),
  "models.cancelLogin": defineMethod({
    name: "models.cancelLogin",
    permission: "pi:admin",
    idempotent: false,
    params: LogoutParams,
    result: Ok,
    // Cancels the caller's own live flow for the provider (a reload lost the flow id). No step-up: it only stops a flow.
    errors: ["not_found"],
  }),
  "subscribe.login": defineMethod({
    name: "subscribe.login",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ flowId: FlowId, after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["not_found", "capacity"],
  }),
  "models.setApiKey": defineMethod({
    name: "models.setApiKey",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: ["provider"],
    params: SetApiKeyParams,
    result: Ok,
    // A password step-up is required (owner c3). timeout: whether the key was stored is unknown.
    errors: ["step_up_required", ...CREDENTIAL_WRITE_ERRORS],
  }),
  "models.logout": defineMethod({
    name: "models.logout",
    permission: "pi:admin",
    idempotent: false,
    params: LogoutParams,
    result: Ok,
    // Removing a credential never asks for the password (M7R133); Pi keeps one credential per provider (M7R61).
    errors: [...CREDENTIAL_WRITE_ERRORS],
  }),
};

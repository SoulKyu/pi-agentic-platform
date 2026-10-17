import { z } from "zod";
import { checkBaseUrl, PROVIDER_FORM_LIMITS, plainLine } from "./base-url.ts";
import { credentialName } from "./credential-words.ts";
import { ConfigGetHelperParams, Revision } from "./models-config.ts";
import { defineMethod } from "./define.ts";
import { ConfigSaveResult } from "./models-config.ts";

/** API types the form offers (MPR10). Each loads in Pi's own loader (helper test); the enum is the only guard against a typo. */
export const PROVIDER_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
] as const;
/** The literal Pi needs to count a keyless local server as available. Not a secret. */
export const NO_KEY_LITERAL = "local-no-key";

/** The id of a provider the form WRITES. Get and remove take any id the file holds (MP-RT-02): `AnyProviderId`. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ProviderId = z.string().regex(PROVIDER_ID_PATTERN);
export const AnyProviderId = z.string().min(1).max(128);
const EnvName = z.string().regex(ENV_NAME_PATTERN);
const HeaderName = z.string().regex(HEADER_NAME_PATTERN);
/** Headers Pi or the transport owns, plus the ones that carry a session. */
export const BANNED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "keep-alive",
  "expect",
]);

/** A literal never starts with `!` (a command) and never holds `$` (Pi interpolates `$X` and `${X}`, MP-RT-22): use the env option. `keep` is edit only: keep the value the file already holds. */
const HeaderValue = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal"),
      text: z
        .string()
        .min(1)
        .max(1024)
        .refine((t) => /^[\x20-\x7e]+$/.test(t), "printable ASCII")
        .refine((t) => !t.startsWith("!"), "no command")
        .refine((t) => !t.includes("$"), "env reference"),
    })
    .strict(),
  z.object({ kind: z.literal("env"), name: EnvName }).strict(),
  z.object({ kind: z.literal("keep") }).strict(),
]);
const Header = z.object({ name: HeaderName, value: HeaderValue }).strict();

const ModelInput = z
  .object({
    id: z.string().min(1).max(256).refine(plainLine, "one visible line"),
    name: z.string().max(256).refine(plainLine, "one visible line").optional(),
    reasoning: z.boolean().optional(),
    input: z
      .array(z.enum(["text", "image"]))
      .min(1)
      .max(2)
      .optional(),
    contextWindow: z.number().int().positive().max(100_000_000).optional(),
    maxTokens: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

/** `stored`: the key lives in auth.json (models.setApiKey), models.json carries none. `none`: a keyless local server. `keep`: edit only. */
export const ProviderAuthInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stored") }).strict(),
  z.object({ kind: z.literal("env"), name: EnvName }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("keep") }).strict(),
]);

export const ProviderInput = z
  .object({
    id: ProviderId,
    name: z
      .string()
      .trim()
      .min(1)
      .max(PROVIDER_FORM_LIMITS.name)
      .refine(plainLine, "one visible line")
      .optional(),
    api: z.enum(PROVIDER_API_TYPES),
    baseUrl: z.string().transform((raw, ctx) => {
      const checked = checkBaseUrl(raw);
      if (checked.ok) return checked.url;
      ctx.addIssue({ code: "custom", message: checked.reason });
      return z.NEVER;
    }),
    auth: ProviderAuthInput,
    headers: z.array(Header).max(PROVIDER_FORM_LIMITS.headers),
    models: z.array(ModelInput).max(PROVIDER_FORM_LIMITS.models),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.models.forEach((model, index) => {
      if (ids.has(model.id))
        ctx.addIssue({ code: "custom", path: ["models", index, "id"], message: "duplicate" });
      ids.add(model.id);
    });
    const names = new Set<string>();
    value.headers.forEach((header, index) => {
      const lower = header.name.toLowerCase();
      const bad =
        BANNED_HEADERS.has(lower) ||
        names.has(lower) ||
        (header.value.kind === "literal" && credentialName(header.name));
      if (bad) ctx.addIssue({ code: "custom", path: ["headers", index], message: "header" });
      names.add(lower);
    });
  });
export type ProviderInput = z.infer<typeof ProviderInput>;

const SaveShape = {
  mode: z.enum(["create", "update"]),
  id: ProviderId,
  provider: ProviderInput,
  baseRevision: Revision,
};
const checkSave = (
  value: { mode: "create" | "update"; id: string; provider: ProviderInput },
  ctx: z.RefinementCtx,
): void => {
  if (value.id !== value.provider.id) ctx.addIssue({ code: "custom", path: ["id"], message: "id mismatch" });
  if (
    value.mode === "create" &&
    (value.provider.auth.kind === "keep" || value.provider.headers.some((h) => h.value.kind === "keep"))
  )
    ctx.addIssue({ code: "custom", path: ["provider"], message: "keep needs update" });
};
/** `id` and `mode` ride at the top level so the receipt selector (`sensitiveParams`) binds the target (MP-RT-03). */
export const ProviderSaveParams = z.object(SaveShape).strict().superRefine(checkSave);
export type ProviderSaveParams = z.infer<typeof ProviderSaveParams>;
export const ProviderRemoveParams = z
  .object({ id: AnyProviderId, baseRevision: Revision, alsoRemoveKey: z.boolean() })
  .strict();
export type ProviderRemoveParams = z.infer<typeof ProviderRemoveParams>;
/** No `id`: only the file's revision comes back (a form opened to create a provider). */
export const ProviderGetParams = z.object({ id: AnyProviderId.optional() }).strict();
/** The form's view of one provider; every literal header value is `keep` (masked), never a value. `advanced`: the entry holds fields the form does not own. */
export const ProviderGetResult = z.union([
  z
    .object({
      editable: z.literal(true),
      provider: ProviderInput,
      revision: Revision,
      advanced: z.boolean(),
      /** `auth.json` holds a credential for this id. Pi uses it before any `apiKey` of `models.json`. Absent: none. */
      keyStored: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      editable: z.literal(false),
      reason: z.enum(["not_in_file", "builtin", "api_unsupported", "url_unsupported", "needs_raw_editor"]),
      revision: Revision,
      /** Only on a `get` with no id: the ids `auth.json` holds a credential for (never a value), so the add form can warn. */
      storedKeys: z.array(z.string().min(1).max(128)).max(300).optional(),
    })
    .strict(),
]);

export type ProviderGetResult = z.infer<typeof ProviderGetResult>;

/** What the daemon, not the client, gives the helper: the boot key the revision is made with. */
export const ProviderGetHelperParams = ProviderGetParams.extend(ConfigGetHelperParams.shape);
export const ProviderSaveHelperParams = z
  .object({ ...SaveShape, ...ConfigGetHelperParams.shape })
  .strict()
  .superRefine(checkSave);
export const ProviderRemoveHelperParams = ProviderRemoveParams.extend(ConfigGetHelperParams.shape);

const PROVIDER_WRITE_ERRORS = [
  "step_up_required",
  "conflict",
  "not_found",
  "capacity",
  "timeout",
  "helper_failed",
  "config_invalid",
  "config_path_refused",
  "config_hard_link",
] as const;

/**
 * Browser sessions only (`pi:admin`, MPR8). Save and remove take the password step-up; get does not. A refusal for
 * invalid content is a `config_invalid` result, not an error. Both writes list the target in `sensitiveParams`.
 */
export const modelsProviderFormMethods = {
  "models.provider.get": defineMethod({
    name: "models.provider.get",
    permission: "pi:admin",
    idempotent: true,
    params: ProviderGetParams,
    result: ProviderGetResult,
    errors: ["capacity", "timeout", "helper_failed", "config_invalid", "config_path_refused"],
  }),
  "models.provider.save": defineMethod({
    name: "models.provider.save",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: ["id", "mode", "baseRevision"],
    params: ProviderSaveParams,
    result: ConfigSaveResult,
    errors: [...PROVIDER_WRITE_ERRORS],
  }),
  "models.provider.remove": defineMethod({
    name: "models.provider.remove",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: ["id", "baseRevision", "alsoRemoveKey"],
    params: ProviderRemoveParams,
    result: ConfigSaveResult,
    errors: [...PROVIDER_WRITE_ERRORS],
  }),
} as const;

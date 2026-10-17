import {
  type BaseUrlRefusal,
  BANNED_HEADERS,
  checkBaseUrl,
  credentialName,
  ENV_NAME_PATTERN,
  HEADER_NAME_PATTERN,
  PROVIDER_ID_PATTERN,
  PROVIDER_FORM_LIMITS,
  ProviderInput,
} from "@pap/contracts";
import type { Preset, ProviderApi } from "./presets.ts";

export type AuthDraft =
  | { readonly kind: "stored" }
  | { readonly kind: "none" }
  | { readonly kind: "keep" }
  | { readonly kind: "env"; readonly name: string };
export type HeaderValueDraft =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "keep" };
export interface HeaderDraft {
  readonly name: string;
  readonly value: HeaderValueDraft;
}
/** Numbers are text while typed; `toInput` sends a number only when the text is a whole one. */
export interface ModelDraft {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly image: boolean;
  readonly contextWindow: string;
  readonly maxTokens: string;
}
/** No key: the form holds none (MPR12); a stored key is typed in `ApiKeyForm` after the save. */
export interface Draft {
  readonly id: string;
  readonly name: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly auth: AuthDraft;
  readonly headers: readonly HeaderDraft[];
  readonly models: readonly ModelDraft[];
}

export const emptyModel = (): ModelDraft => ({
  id: "",
  name: "",
  reasoning: false,
  image: false,
  contextWindow: "",
  maxTokens: "",
});
export const emptyHeader = (): HeaderDraft => ({ name: "", value: { kind: "literal", text: "" } });

export const emptyDraft = (preset?: Preset): Draft => ({
  id: preset?.id ?? "",
  name: preset?.name ?? "",
  api: preset?.api ?? "openai-completions",
  baseUrl: preset?.baseUrl ?? "",
  auth: preset?.auth === "none" ? { kind: "none" } : { kind: "stored" },
  headers: [],
  models: [],
});

const text = (value: number | undefined): string => (value === undefined ? "" : String(value));

/** The draft of a provider `models.provider.get` returned; kept values stay `keep`. */
export const draftOf = (provider: ProviderInput): Draft => ({
  id: provider.id,
  name: provider.name ?? "",
  api: provider.api,
  baseUrl: provider.baseUrl,
  auth:
    provider.auth.kind === "env" ? { kind: "env", name: provider.auth.name } : { kind: provider.auth.kind },
  headers: provider.headers.map((header) => ({ name: header.name, value: header.value })),
  models: provider.models.map((model) => ({
    id: model.id,
    name: model.name ?? "",
    reasoning: model.reasoning === true,
    image: model.input?.includes("image") === true,
    contextWindow: text(model.contextWindow),
    maxTokens: text(model.maxTokens),
  })),
});

const WHOLE = /^[1-9]\d{0,8}$/;
const whole = (value: string): number | undefined => {
  const trimmed = value.trim();
  return WHOLE.test(trimmed) ? Number(trimmed) : undefined;
};

/** Only spaces at the ends go (a pasted address): a tab or a line break is still refused by `checkBaseUrl`. */
const urlOf = (draft: Draft): string => draft.baseUrl.replace(/^ +| +$/g, "");

/** The exact object sent to `models.provider.save`: trimmed, optional fields left out, never a key. */
export function toInput(draft: Draft): ProviderInput {
  const name = draft.name.trim();
  return {
    id: draft.id.trim(),
    ...(name === "" ? {} : { name }),
    api: draft.api,
    baseUrl: urlOf(draft),
    auth:
      draft.auth.kind === "env" ? { kind: "env", name: draft.auth.name.trim() } : { kind: draft.auth.kind },
    headers: draft.headers.map((header) => ({
      name: header.name.trim(),
      value:
        header.value.kind === "literal"
          ? { kind: "literal", text: header.value.text }
          : header.value.kind === "env"
            ? { kind: "env", name: header.value.name.trim() }
            : { kind: "keep" },
    })),
    models: draft.models.map((model) => {
      const modelName = model.name.trim();
      const contextWindow = whole(model.contextWindow);
      const maxTokens = whole(model.maxTokens);
      return {
        id: model.id.trim(),
        ...(modelName === "" ? {} : { name: modelName }),
        ...(model.reasoning ? { reasoning: true } : {}),
        ...(model.image ? { input: ["text" as const, "image" as const] } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
    }),
  };
}

/** True when a key or a secret header rides along: a stored or env auth, a kept value, or any header given as an env var. */
export const carriesSecret = (draft: Draft): boolean =>
  draft.auth.kind !== "none" || draft.headers.some((header) => header.value.kind !== "literal");

export const PROBLEM_KEYS = [
  "id.required",
  "id.format",
  "id.builtin",
  "id.exists",
  "name.long",
  "baseUrl.required",
  "baseUrl.invalid",
  "baseUrl.scheme",
  "baseUrl.credentials",
  "baseUrl.query",
  "baseUrl.host",
  "baseUrl.long",
  "auth.envName",
  "headers.limit",
  "headers.name",
  "headers.duplicate",
  "headers.credential",
  "headers.dollar",
  "headers.bang",
  "headers.value",
  "headers.envName",
  "models.limit",
  "models.idRequired",
  "models.duplicate",
  "models.number",
  "form.invalid",
] as const;
export type ProblemKey = (typeof PROBLEM_KEYS)[number];
/** `at`: `id`, `name`, `baseUrl`, `auth`, `headers`, `headers.<n>`, `models`, `models.<n>.<field>` or `form`. */
export interface Problem {
  readonly key: ProblemKey;
  readonly at: string;
}

const URL_PROBLEM: Record<BaseUrlRefusal, ProblemKey> = {
  too_long: "baseUrl.long",
  control: "baseUrl.invalid",
  not_a_url: "baseUrl.invalid",
  scheme: "baseUrl.scheme",
  credentials: "baseUrl.credentials",
  query_or_fragment: "baseUrl.query",
  host: "baseUrl.host",
};

/**
 * What stops Save: the server's own checks, run here with the same code (`checkBaseUrl`, `ProviderInput`). The named
 * rules say which field and why; whatever `ProviderInput` still refuses comes back as `form.invalid`.
 * `existingIds` is empty when editing (the id is the provider's own).
 */
export function problems(
  draft: Draft,
  existingIds: ReadonlySet<string>,
  builtinIds: ReadonlySet<string>,
): Problem[] {
  const found: Problem[] = [];
  const add = (key: ProblemKey, at: string) => found.push({ key, at });

  const id = draft.id.trim();
  if (id === "") add("id.required", "id");
  else if (!PROVIDER_ID_PATTERN.test(id)) add("id.format", "id");
  else if (builtinIds.has(id)) add("id.builtin", "id");
  else if (existingIds.has(id)) add("id.exists", "id");
  if (draft.name.trim().length > PROVIDER_FORM_LIMITS.name) add("name.long", "name");

  const url = urlOf(draft);
  if (url === "") add("baseUrl.required", "baseUrl");
  else {
    const checked = checkBaseUrl(url);
    if (!checked.ok) add(URL_PROBLEM[checked.reason], "baseUrl");
  }

  if (draft.auth.kind === "env" && !ENV_NAME_PATTERN.test(draft.auth.name.trim()))
    add("auth.envName", "auth");

  if (draft.headers.length > PROVIDER_FORM_LIMITS.headers) add("headers.limit", "headers");
  const seen = new Set<string>();
  draft.headers.forEach((header, index) => {
    const at = `headers.${index}`;
    const name = header.name.trim();
    const lower = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || BANNED_HEADERS.has(lower)) add("headers.name", at);
    else if (seen.has(lower)) add("headers.duplicate", at);
    seen.add(lower);
    const value = header.value;
    if (value.kind === "env" && !ENV_NAME_PATTERN.test(value.name.trim())) add("headers.envName", at);
    if (value.kind !== "literal") return;
    if (credentialName(name)) add("headers.credential", at);
    else if (value.text.includes("$")) add("headers.dollar", at);
    else if (value.text.startsWith("!")) add("headers.bang", at);
    else if (value.text === "") add("headers.value", at);
  });

  if (draft.models.length > PROVIDER_FORM_LIMITS.models) add("models.limit", "models");
  const ids = new Set<string>();
  draft.models.forEach((model, index) => {
    const modelId = model.id.trim();
    if (modelId === "") add("models.idRequired", `models.${index}.id`);
    else if (ids.has(modelId)) add("models.duplicate", `models.${index}.id`);
    ids.add(modelId);
    if (model.contextWindow.trim() !== "" && whole(model.contextWindow) === undefined)
      add("models.number", `models.${index}.contextWindow`);
    if (model.maxTokens.trim() !== "" && whole(model.maxTokens) === undefined)
      add("models.number", `models.${index}.maxTokens`);
  });

  if (found.length === 0 && !ProviderInput.safeParse(toInput(draft)).success) add("form.invalid", "form");
  return found;
}

export const problemAt = (list: readonly Problem[], at: string): ProblemKey | undefined =>
  list.find((problem) => problem.at === at)?.key;

/** Where the helper's `config_invalid` paths land in the form (`$.file`, `$.providers`, `$.provider.<field>`). */
export interface IssueTargets {
  readonly file: boolean;
  readonly providers: boolean;
  readonly other: boolean;
  /** `at` values of `Problem`: a field or a row. */
  readonly at: ReadonlySet<string>;
}

export function issueTargets(issues: readonly string[]): IssueTargets {
  let file = false;
  let providers = false;
  let other = false;
  const at = new Set<string>();
  for (const issue of issues) {
    const header = /^\$\.provider\.headers\[(\d{1,3})\]$/.exec(issue);
    const model = /^\$\.provider\.models\[(\d{1,4})\]/.exec(issue);
    if (issue === "$.file") file = true;
    else if (issue === "$.providers") providers = true;
    else if (issue === "$.provider.id") at.add("id");
    else if (issue === "$.provider.baseUrl") at.add("baseUrl");
    else if (header) at.add(`headers.${header[1]}`);
    else if (model) at.add(`models.${model[1]}`);
    else other = true;
  }
  return { file, providers, other, at };
}

/** An identifier proposed from a name: lower-case letters, digits, - and _. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64);

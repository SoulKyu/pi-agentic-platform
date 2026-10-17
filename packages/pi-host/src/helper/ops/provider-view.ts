import { checkBaseUrl, NO_KEY_LITERAL, PROVIDER_API_TYPES, ProviderInput } from "@pap/contracts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ENV_REF = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]{0,63})\}|([A-Za-z_][A-Za-z0-9_]{0,63}))$/;
export const OWNED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "name",
  "api",
  "baseUrl",
  "apiKey",
  "headers",
  "models",
]);
export const OWNED_MODEL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
]);

export type ViewOutcome =
  | { readonly editable: true; readonly provider: ProviderInput; readonly advanced: boolean }
  | { readonly editable: false; readonly reason: "api_unsupported" | "url_unsupported" | "needs_raw_editor" };

const authOf = (apiKey: unknown): unknown => {
  if (apiKey === undefined) return { kind: "stored" };
  if (apiKey === NO_KEY_LITERAL) return { kind: "none" };
  if (typeof apiKey !== "string") return { kind: "keep" };
  const env = ENV_REF.exec(apiKey);
  return env ? { kind: "env", name: env[1] ?? env[2] } : { kind: "keep" };
};

/**
 * The form's view of a provider the file holds (MP-RT-02). Built from the file, so a literal key and every literal header value are `keep` and
 * never a value. Anything outside the form's grammar (an unknown api, a URL the policy refuses, an odd header name, an
 * `input` the form lacks) is `editable: false` with a reason, never an error and never a path or a value.
 */
export function viewOf(id: string, entry: unknown): ViewOutcome {
  if (!isObject(entry)) return { editable: false, reason: "needs_raw_editor" };
  if (!PROVIDER_API_TYPES.includes(entry.api as never)) return { editable: false, reason: "api_unsupported" };
  if (typeof entry.baseUrl !== "string") return { editable: false, reason: "needs_raw_editor" };
  if (!checkBaseUrl(entry.baseUrl).ok) return { editable: false, reason: "url_unsupported" };
  const headers: unknown[] = [];
  if (entry.headers !== undefined) {
    if (!isObject(entry.headers)) return { editable: false, reason: "needs_raw_editor" };
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value !== "string") return { editable: false, reason: "needs_raw_editor" };
      const env = ENV_REF.exec(value);
      // Every literal value stays in the file (M7R62, as the raw editor masks all values under `headers`): the form offers "replace".
      headers.push({ name, value: env ? { kind: "env", name: env[1] ?? env[2] } : { kind: "keep" } });
    }
  }
  const rawModels: unknown[] =
    entry.models === undefined ? [] : Array.isArray(entry.models) ? entry.models : [null];
  const models = rawModels.map((model) => {
    if (!isObject(model)) return null;
    const { id: modelId, name, reasoning, input, contextWindow, maxTokens } = model;
    return { id: modelId, name, reasoning, input, contextWindow, maxTokens };
  });
  const parsed = ProviderInput.safeParse({
    id,
    name: entry.name,
    api: entry.api,
    baseUrl: entry.baseUrl,
    auth: authOf(entry.apiKey),
    headers,
    models,
  });
  if (!parsed.success) return { editable: false, reason: "needs_raw_editor" };
  const advanced =
    Object.keys(entry).some((key) => !OWNED_PROVIDER_KEYS.has(key)) ||
    rawModels.some(
      (model) => isObject(model) && Object.keys(model).some((key) => !OWNED_MODEL_KEYS.has(key)),
    );
  return { editable: true, provider: parsed.data, advanced };
}

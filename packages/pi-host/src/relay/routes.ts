import { hasDuplicateTopLevelKey } from "./json-keys.ts";

export type ApiKind =
  "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export const RELAY_HOSTS = Object.freeze({ llm: "llm.internal", claude: "claude.internal" });

/** A Map, never an object: `__proto__` or `constructor` as an api name finds nothing (RT-36). */
const PATHS: ReadonlyMap<string, readonly RegExp[]> = new Map<ApiKind, readonly RegExp[]>([
  ["anthropic-messages", [/^\/v1\/messages$/, /^\/v1\/messages\/count_tokens$/]],
  ["openai-completions", [/^\/chat\/completions$/]],
  ["openai-responses", [/^\/responses$/]],
  // Google's SDK may keep its version segment in the path (RT-36); relay.int.test.ts pins what Pi's client sends.
  [
    "google-generative-ai",
    [
      /^(?:\/v1beta|\/v1)?\/models\/[A-Za-z0-9._-]{1,128}:(?:streamGenerateContent|generateContent|countTokens)$/,
    ],
  ],
]);
const GOOGLE_MODEL = /\/models\/([A-Za-z0-9._-]{1,128}):/;
const QUERIES: ReadonlySet<string> = new Set(["", "?beta=true", "?alt=sse"]);
const SAFE_PATH = /^\/[A-Za-z0-9._~:-]+(?:\/[A-Za-z0-9._~:-]+)*$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The Host a VM sends: one of the two names, with the relay's port or none. */
const HOST = /^([a-z.]{1,32})(?::(\d{1,5}))?$/;

export type RelayRoute =
  | { readonly kind: "provider"; readonly provider: string; readonly path: string; readonly query: string }
  | { readonly kind: "claude"; readonly path: string; readonly query: string };

/** Spec §9: what a VM may ask, judged on the request line and Host before any key or credential is looked at. */
export function routeOf(
  method: string | undefined,
  host: string | undefined,
  url: string | undefined,
): RelayRoute | null {
  if (method !== "POST" || host === undefined || url === undefined) return null;
  const named = HOST.exec(host.toLowerCase());
  if (named === null) return null;
  const name = named[1];
  const cut = url.indexOf("?");
  const pathPart = cut < 0 ? url : url.slice(0, cut);
  const query = cut < 0 ? "" : url.slice(cut);
  if (!QUERIES.has(query) || !SAFE_PATH.test(pathPart)) return null;
  const segments = pathPart.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === ".." || /^\.+$/.test(segment))) return null;
  if (name === RELAY_HOSTS.claude)
    return pathAllowed("anthropic-messages", pathPart) ? { kind: "claude", path: pathPart, query } : null;
  if (name !== RELAY_HOSTS.llm) return null;
  const [provider, ...rest] = segments;
  if (provider === undefined || !PROVIDER.test(provider) || rest.length === 0) return null;
  return { kind: "provider", provider, path: `/${rest.join("/")}`, query };
}

export function pathAllowed(api: string, path: string): boolean {
  return PATHS.get(api)?.some((re) => re.test(path)) ?? false;
}

/**
 * Where a request names its model, before the provider's api is known: Google's SDK puts it in the path, every other
 * client in the JSON body. `pathAllowed` then judges the path against the real api, so a lie here is refused there.
 */
export const modelSourceOf = (path: string): "google-generative-ai" | "body" =>
  GOOGLE_MODEL.test(path) ? "google-generative-ai" : "body";

/** RT-17: the model a request names: in the path for Google, else the body's `model` (a string of at most 256 characters). */
export function modelOf(api: string, path: string, body: Buffer): string | null {
  if (api === "google-generative-ai") return GOOGLE_MODEL.exec(path)?.[1] ?? null;
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // JSON.parse keeps the last of two `model` keys; the provider may keep the first (T12): such a body names no model.
  if (hasDuplicateTopLevelKey(body, "model")) return null;
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" && model.length > 0 && model.length <= 256 ? model : null;
}

import { join } from "node:path";
import {
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAuthFileStore } from "../helper/ops/auth-store.ts";
import { guardFile } from "../helper/ops/models-open.ts";
import type { UpstreamCredential } from "./headers.ts";
import type { ApiKind } from "./routes.ts";

/** How long an answer is kept (a provider the owner just changed is seen within a minute). */
export const CREDENTIAL_CACHE_MS = 60_000;
const APIS: ReadonlySet<string> = new Set<ApiKind>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Names a provider's own headers never carry to an upstream (the usage op and the relay agree). */
const NEVER_COPIED = new Set(["host", "cookie", "content-length"]);

/** The credential headers Pi resolved, as strings only: a null value (a removed header) and framing names are dropped. */
export function authHeaderEntries(
  headers: Readonly<Record<string, string | null>> | undefined,
): Array<[string, string]> {
  return Object.entries(headers ?? {}).flatMap(([name, value]): Array<[string, string]> =>
    typeof value === "string" && !NEVER_COPIED.has(name.toLowerCase()) ? [[name, value]] : [],
  );
}

/** The part of Pi's runtime the relay uses: the tests hand in a stand-in. */
export interface RelayModelRuntime {
  getProvider(id: string): { readonly headers?: Readonly<Record<string, string | null>> } | undefined;
  getModels(id: string): ReadonlyArray<{ readonly api: string; readonly baseUrl?: string }>;
  checkAuth(id: string): Promise<{ readonly type: "api_key" | "oauth" } | undefined>;
  getAuth(id: string): Promise<
    | {
        readonly auth: {
          readonly apiKey?: string;
          readonly headers?: Readonly<Record<string, string | null>>;
          readonly baseUrl?: string;
        };
      }
    | undefined
  >;
}
/** A fresh read of Pi's files: the runtime and the providers the owner's `enabledModels` leaves (null: no list, all). */
export type RelaySource = () => Promise<{
  readonly runtime: RelayModelRuntime;
  readonly enabled: ReadonlySet<string> | null;
}>;

export interface ResolvedProvider {
  readonly api: ApiKind;
  readonly baseUrl: string;
  readonly credential: UpstreamCredential;
}

/**
 * Pi's files on the host, read the way `models.*` reads them (the Pi file boundary): the credential store and the
 * models.json guard of the helper. No extension is loaded and nothing is fetched (`refreshOnCreate: false`, no model
 * network): the relay serves what models.json and auth.json say.
 */
export const openRelaySource =
  (where: { readonly agentDir: string; readonly home: string }): RelaySource =>
  async () => {
    const modelsPath = join(where.agentDir, "models.json");
    await guardFile(modelsPath, [where.agentDir, where.home]);
    await guardFile(join(where.agentDir, "settings.json"), [where.agentDir, where.home]);
    const runtime = await ModelRuntime.create({
      credentials: createAuthFileStore(where),
      modelsPath,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const patterns = SettingsManager.create(where.agentDir, where.agentDir, {
      projectTrusted: false,
    }).getEnabledModels();
    if (patterns === undefined) return { runtime, enabled: null };
    const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], runtime);
    return { runtime, enabled: new Set(scopedModels.map(({ model }) => model.provider)) };
  };

/** `https:` always; `http:` only to loopback and only in test mode (R9); no userinfo, query or fragment. */
function safeBaseUrl(raw: string | undefined, testLoopback: boolean): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const secure = url.protocol === "https:";
  if (!secure && !(testLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * `resolveProvider(provider)` (R9): the api, base URL and credential Pi's auth storage holds for an API-key provider of
 * the owner's enabled models, or null. An OAuth credential, an `http:` base URL, an unknown api, no key and any failure of
 * Pi's files all answer null (the caller refuses; nothing of the failure is kept). Answers are kept 60 seconds.
 */
export function createProviderResolver(deps: {
  readonly open: RelaySource;
  readonly clock: { now(): number };
  /** True when `PAP_TEST_PROVIDER_SCRIPT` is set: loopback `http:` base URLs are then allowed. */
  readonly testLoopback: boolean;
}): (provider: string) => Promise<ResolvedProvider | null> {
  const cache = new Map<string, { at: number; value: ResolvedProvider }>();
  async function load(provider: string): Promise<ResolvedProvider | null> {
    const { runtime, enabled } = await deps.open();
    if (enabled !== null && !enabled.has(provider)) return null;
    const configured = runtime.getProvider(provider);
    const [model] = runtime.getModels(provider);
    if (configured === undefined || model === undefined || !APIS.has(model.api)) return null;
    if ((await runtime.checkAuth(provider))?.type !== "api_key") return null;
    const resolved = await runtime.getAuth(provider);
    const apiKey = resolved?.auth.apiKey;
    if (resolved === undefined || apiKey === undefined || apiKey === "") return null;
    const baseUrl = safeBaseUrl(resolved.auth.baseUrl ?? model.baseUrl, deps.testLoopback);
    if (baseUrl === null) return null;
    const headers: Record<string, string> = {};
    for (const [name, value] of [
      ...authHeaderEntries(configured.headers),
      ...authHeaderEntries(resolved.auth.headers),
    ])
      headers[name] = value;
    return { api: model.api as ApiKind, baseUrl, credential: { value: apiKey, headers } };
  }
  return async (provider) => {
    const hit = cache.get(provider);
    if (hit !== undefined && deps.clock.now() - hit.at < CREDENTIAL_CACHE_MS) return hit.value;
    cache.delete(provider);
    let value: ResolvedProvider | null;
    try {
      value = await load(provider);
    } catch {
      return null;
    }
    if (value !== null) cache.set(provider, { at: deps.clock.now(), value });
    return value;
  };
}

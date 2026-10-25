import {
  HELPER_OPS,
  isProviderUsageId,
  type ModelsUsageResult,
  type ProviderUsageId,
  UsageReport,
} from "@pap/contracts/pi-host";
import type { z } from "zod";
import { authHeaderEntries } from "../../relay/credentials.ts";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { openExtensionLoad, loadRuntime } from "./extension-load.ts";
import { normalizeUsage, PROVIDER_NAMES, UnusableAnswer } from "./models-usage-normalize.ts";
import { deadline, readCapped, strictFetch } from "./provider-request.ts";

/** The most a usage answer may weigh: these are a few hundred bytes of JSON. */
export const USAGE_BODY_MAX_BYTES = 65_536;
export const USAGE_TIMEOUT_MS = 15_000;

/**
 * The only addresses a stored credential is ever sent to (M10R109): one https URL per provider. A provider whose
 * configured base URL is not on the same origin is refused before its credential is even resolved.
 */
const ENDPOINTS: Readonly<Record<ProviderUsageId, string>> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  deepseek: "https://api.deepseek.com/user/balance",
  openrouter: "https://openrouter.ai/api/v1/key",
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  "moonshotai-cn": "https://api.moonshot.cn/v1/users/me/balance",
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/credits",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
  "kimi-coding": "https://api.kimi.com/coding/v1/usages",
};

const FAILED = { status: "query_failed" } as const;
const NO_AUTH = { status: "auth_unavailable" } as const;
const OVERRIDDEN = { status: "provider_overridden" } as const;
const EXTENSIONS_FAILED = { status: "extensions_failed" } as const;

/** The part of Pi's runtime this operation uses: the tests hand in a stand-in. */
export interface UsageRuntime {
  /** True when an enabled extension failed to load or to register: nothing is sent (fail closed). */
  readonly extensionsFailed?: boolean;
  /** True when an enabled extension registered or replaced this provider, as sessions would see it. */
  overriddenByExtension?(providerId: string): boolean;
  getProvider(providerId: string): { readonly baseUrl?: string } | undefined;
  getModels(providerId: string): ReadonlyArray<{ readonly baseUrl?: string }>;
  getAuth(
    providerId: string,
    overrides?: { readonly signal?: AbortSignal },
  ): Promise<
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

export interface UsageDeps {
  readonly open?: (ctx: HelperContext) => Promise<UsageRuntime>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** `https` and the same origin as the provider's official endpoint, nothing else: no other port, no userinfo trick. */
export function isOfficialOrigin(providerId: ProviderUsageId, baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    const candidate = new URL(baseUrl);
    return candidate.protocol === "https:" && candidate.origin === new URL(ENDPOINTS[providerId]).origin;
  } catch {
    return false;
  }
}

async function openUsageRuntime(ctx: HelperContext): Promise<UsageRuntime> {
  const { runtime, touched, extensionsFailed } = await openExtensionLoad(ctx);
  return {
    extensionsFailed,
    overriddenByExtension: (id) => touched.has(id),
    getProvider: (id) => runtime.getProvider(id),
    getModels: (id) => runtime.getModels(id),
    getAuth: (id, overrides) => runtime.getAuth(id, overrides),
  };
}

function endpointOf(providerId: ProviderUsageId, token: string | undefined): string {
  const base = ENDPOINTS[providerId];
  if (providerId !== "minimax" && providerId !== "minimax-cn") return base;
  return `${base}${token?.startsWith("sk-api-") ? "/account/query_balance" : "/v1/token_plan/remains"}`;
}

function requestHeaders(auth: { apiKey?: string; headers?: Readonly<Record<string, string | null>> }) {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of authHeaderEntries(auth.headers)) headers.set(name, value);
  if (!headers.has("authorization") && auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
  return headers;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One GET to the provider's official usage endpoint with the key Pi stores for it, on the owner's click (M10R109,
 * M10R110). The answer is untrusted: size-capped, parsed, reduced to the strict `UsageReport`. A failure is a status;
 * nothing the provider said and nothing of a credential is in it, in a log or on stderr.
 */
export function createUsageOp(
  deps: UsageDeps = {},
): HelperOp<z.infer<(typeof HELPER_OPS)["models.usage"]["params"]>, ModelsUsageResult> {
  const open = deps.open ?? openUsageRuntime;
  const fetchImpl = deps.fetchImpl ?? strictFetch;
  const timeoutMs = deps.timeoutMs ?? USAGE_TIMEOUT_MS;
  return {
    params: HELPER_OPS["models.usage"].params,
    run: async (params, ctx) => {
      if (!isProviderUsageId(params.providerId)) return { status: "unsupported" };
      const id = params.providerId;
      const runtime = await loadRuntime(open, ctx);
      if (runtime.extensionsFailed === true) return EXTENSIONS_FAILED;
      // The effective base URL, extensions included. An extension that moved the provider is told apart from a
      // models.json that did; either way nothing is resolved and nothing is sent.
      const refused = (): typeof FAILED | typeof OVERRIDDEN =>
        runtime.overriddenByExtension?.(id) === true ? OVERRIDDEN : FAILED;
      const baseUrl = runtime.getProvider(id)?.baseUrl ?? runtime.getModels(id)[0]?.baseUrl;
      if (runtime.getProvider(id) === undefined || !isOfficialOrigin(id, baseUrl)) return refused();
      const cancelled = () => ctx.signal.aborted;
      // Resolving the credential is not bounded by the usage deadline: an OAuth refresh in progress must finish and be
      // persisted, or a rotated refresh token is lost. Pi bounds the refresh itself; the run's cancel still ends the wait.
      let resolved: Awaited<ReturnType<UsageRuntime["getAuth"]>>;
      try {
        resolved = await runtime.getAuth(id, { signal: ctx.signal });
      } catch {
        if (cancelled()) throw new HelperOpError("failed", "cancelled");
        return NO_AUTH;
      }
      if (resolved === undefined) return NO_AUTH;
      const { auth } = resolved;
      if (auth.baseUrl !== undefined && !isOfficialOrigin(id, auth.baseUrl)) return refused();
      const limit = deadline(ctx.signal, timeoutMs);
      try {
        const headers = requestHeaders(auth);
        const token = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? auth.apiKey;
        const response = await fetchImpl(endpointOf(id, token), {
          method: "GET",
          headers,
          redirect: "error",
          credentials: "omit",
          signal: limit.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return FAILED;
        }
        const text = await readCapped(response, USAGE_BODY_MAX_BYTES);
        const payload: unknown = text === null ? null : JSON.parse(text);
        if (!isRecord(payload)) return FAILED;
        const parsed = UsageReport.safeParse({
          providerId: id,
          providerName: PROVIDER_NAMES[id],
          capturedAt: Date.now(),
          ...normalizeUsage(id, payload),
        });
        return parsed.success ? { status: "ready", report: parsed.data } : FAILED;
      } catch (error) {
        if (error instanceof HelperOpError) throw error;
        if (cancelled()) throw new HelperOpError("failed", "cancelled");
        // An unusable answer, a refused redirect, a network error and the deadline all read the same to the owner.
        if (!(error instanceof UnusableAnswer) && !limit.timedOut())
          process.stderr.write("pap-helper: usage_query_failed\n");
        return FAILED;
      } finally {
        limit.dispose();
      }
    },
  };
}

export const modelsUsageOp = defineOp(createUsageOp());

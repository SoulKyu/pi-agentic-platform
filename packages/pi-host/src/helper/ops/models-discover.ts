import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DISCOVERED_MODELS_MAX,
  HELPER_OPS,
  type ModelsDiscoverResult,
  type ModelsTestResult,
} from "@pap/contracts";
import type { z } from "zod";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { openRuntime } from "./models-open.ts";
import { deadline, readCapped, statusClassOf, strictFetch } from "./provider-request.ts";

/** Both requests are the owner's click and wait this long at most (M7R66). */
export const PROVIDER_TIMEOUT_MS = 15_000;
/** What the discover answer may weigh: the helper's record stops at 1 MiB, and the daemon's pages at 900 000 bytes (M2R54). */
const ANSWER_MAX_BYTES = 800_000;
/** A model list over this is not a model list. */
const LIST_MAX_BYTES = 4 * 1024 * 1024;
/** A test costs one completion of this many output tokens at most (M7R66). */
export const TEST_MAX_OUTPUT_TOKENS = 16;

type Params<N extends "models.discover" | "models.test"> = z.infer<(typeof HELPER_OPS)[N]["params"]>;
type DiscoveredModel = ModelsDiscoverResult["models"][number];
interface Options {
  readonly timeoutMs?: number;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * The three fields a discovered entry gives, and no other: gateways use the rest for different things (pi-web #856), and
 * an entry may carry text a gateway should not be trusted with.
 */
function discoveredModel(entry: unknown): DiscoveredModel | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const { id, contextWindow, maxTokens, reasoning } = entry as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return null;
  return {
    id,
    ...(positiveInteger(contextWindow) === undefined
      ? {}
      : { contextWindow: positiveInteger(contextWindow) }),
    ...(positiveInteger(maxTokens) === undefined ? {} : { maxTokens: positiveInteger(maxTokens) }),
    ...(reasoning === true ? { reasoning: true } : {}),
  };
}

/** The list of a `{ data }`, a `{ models }` or a bare array answer; anything else is no list. */
function listOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body !== "object" || body === null) return null;
  const { data, models } = body as Record<string, unknown>;
  if (Array.isArray(data)) return data;
  return Array.isArray(models) ? models : null;
}

const headersOf = (...sources: Array<Record<string, string | null> | undefined>): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const source of sources)
    for (const [name, value] of Object.entries(source ?? {}))
      if (typeof value === "string") merged[name] = value;
  return merged;
};

/**
 * Where a provider is asked and with what: its own base URL and key as Pi resolves them. A `!command` key runs here, in
 * the helper, after the password step-up (owner c3). Nothing of it is returned.
 */
async function targetOf(runtime: ModelRuntime, providerId: string) {
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new HelperOpError("not_found", "provider");
  const first = runtime.getModels(providerId)[0];
  // A key Pi cannot resolve (a failing `!command`, no key at all) is not an error here: keyless local gateways exist, so
  // the request goes without one. A fixed code on stderr tells the daemon's log which case a 401 came from.
  const auth = await runtime.getAuth(providerId).catch(() => {
    process.stderr.write("pap-helper: auth_unavailable\n");
    return undefined;
  });
  const base = auth?.auth.baseUrl ?? provider.baseUrl ?? first?.baseUrl;
  if (base === undefined) throw new HelperOpError("bad_params", "provider has no base url");
  let url: URL;
  try {
    url = new URL(`${base.replace(/\/+$/, "")}/models`);
  } catch {
    throw new HelperOpError("bad_params", "base url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new HelperOpError("bad_params", "base url");
  const key = auth?.auth.apiKey;
  const headers = headersOf(first?.headers, provider.headers, auth?.auth.headers);
  const named = (name: string) => Object.keys(headers).some((have) => have.toLowerCase() === name);
  if (key !== undefined && !named("authorization")) headers.authorization = `Bearer ${key}`;
  if (key !== undefined && first?.api === "anthropic-messages") {
    if (!named("x-api-key")) headers["x-api-key"] = key;
    if (!named("anthropic-version")) headers["anthropic-version"] = "2023-06-01";
  }
  return { url, headers };
}

/** One `GET <baseUrl>/models`; a failure is a status class and nothing the provider said (M7R66). */
export function createDiscoverOp(
  options: Options = {},
): HelperOp<Params<"models.discover">, ModelsDiscoverResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  return {
    params: HELPER_OPS["models.discover"].params,
    run: async (params, ctx) => {
      const { url, headers } = await targetOf(await openRuntime(ctx), params.provider);
      const limit = deadline(ctx.signal, timeoutMs);
      try {
        const response = await strictFetch(url, { method: "GET", headers, signal: limit.signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { models: [], code: statusClassOf(response.status) };
        }
        const text = await readCapped(response, LIST_MAX_BYTES);
        const list = text === null ? null : listOf(JSON.parse(text));
        if (list === null) return { models: [], code: "network" };
        const seen = new Set<string>();
        const models: DiscoveredModel[] = [];
        let bytes = 16;
        let truncated = false;
        for (const entry of list) {
          const model = discoveredModel(entry);
          if (model === null || seen.has(model.id)) continue;
          const weight = Buffer.byteLength(JSON.stringify(model)) + 1;
          if (models.length === DISCOVERED_MODELS_MAX || bytes + weight > ANSWER_MAX_BYTES) {
            truncated = true;
            break;
          }
          seen.add(model.id);
          models.push(model);
          bytes += weight;
        }
        return truncated ? { models, truncated } : { models };
      } catch {
        if (ctx.signal.aborted) throw new HelperOpError("failed", "cancelled");
        return { models: [], code: limit.timedOut() ? "timeout" : "network" };
      } finally {
        limit.dispose();
      }
    },
  };
}

/**
 * The class of a failed completion, from the HTTP status Pi's request got and nothing else: a number in a provider's
 * text (a port, an id) decides nothing. No status, or one below 400, is `network`.
 */
export function failureClass(status: number | undefined): "http_4xx" | "http_5xx" | "network" {
  return status !== undefined && status >= 400 ? statusClassOf(status) : "network";
}

/** One completion of at most 16 output tokens through Pi's own provider code; only ok, a latency and a class come back. */
export function createTestOp(options: Options = {}): HelperOp<Params<"models.test">, ModelsTestResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  return {
    params: HELPER_OPS["models.test"].params,
    run: async (params, ctx: HelperContext) => {
      const runtime = await openRuntime(ctx);
      const model = runtime.getModel(params.provider, params.modelId);
      if (!model) throw new HelperOpError("not_found", "model");
      const limit = deadline(ctx.signal, timeoutMs);
      const started = performance.now();
      let status: number | undefined;
      try {
        const answer = await runtime.completeSimple(
          model,
          { messages: [{ role: "user", content: "Reply with one word.", timestamp: Date.now() }] },
          {
            maxTokens: TEST_MAX_OUTPUT_TOKENS,
            maxRetries: 0,
            timeoutMs,
            signal: limit.signal,
            // Never a redirect, never a cookie (the key is also sent as x-api-key): the wrapper also notes the status.
            fetch: async (input, init) => {
              const response = await strictFetch(input, init);
              status = response.status;
              return response;
            },
          },
        );
        const latencyMs = Math.max(0, Math.round(performance.now() - started));
        if (ctx.signal.aborted) throw new HelperOpError("failed", "cancelled");
        if (answer.stopReason !== "error" && answer.stopReason !== "aborted") return { ok: true, latencyMs };
        const code = limit.timedOut() ? "timeout" : failureClass(status);
        return { ok: false, latencyMs, code };
      } catch (error) {
        if (error instanceof HelperOpError) throw error;
        if (ctx.signal.aborted) throw new HelperOpError("failed", "cancelled");
        const latencyMs = Math.max(0, Math.round(performance.now() - started));
        return { ok: false, latencyMs, code: limit.timedOut() ? "timeout" : "network" };
      } finally {
        limit.dispose();
      }
    },
  };
}

export const modelsDiscover = createDiscoverOp();
export const modelsTest = createTestOp();
export const modelsDiscoverOp = defineOp(modelsDiscover);
export const modelsTestOp = defineOp(modelsTest);

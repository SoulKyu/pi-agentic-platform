import { HELPER_OPS, SKILL_LIMITS, type SkillsSearchResult } from "@pap/contracts";
import type { z } from "zod";
import { defineOp, type HelperContext, HelperOpError, type HelperOp } from "../ops.ts";
import { readCapped, strictFetch } from "./provider-request.ts";

/** The only address this operation asks, and only on the owner's search (M7R113). */
export const SEARCH_URL = "https://skills.sh/api/search";
export const SEARCH_TIMEOUT_MS = 15_000;
export const SEARCH_MAX_BYTES = 1024 * 1024;

/** The shape of the kernel `Clock`'s timers: a test drives the deadline by hand. */
export interface SearchTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: SearchTimers = {
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Untrusted text: control, bidi and zero-width characters go, the rest is cut to the contract's bound. */
const text = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .replace(CONTROL, "")
        .slice(0, max)
        .replace(/[\ud800-\udbff]$/, "")
    : "";

/** `https:` and nothing else: a `javascript:`, `data:` or `http:` link, or one that does not parse, is dropped. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > SKILL_LIMITS.url) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !CONTROL.test(value) && !/\s/.test(value) ? url.href : null;
  } catch {
    return null;
  } finally {
    CONTROL.lastIndex = 0;
  }
}

function parseResults(body: unknown): SkillsSearchResult["results"] {
  const list = isRecord(body) ? (body.skills ?? body.results) : undefined;
  if (!Array.isArray(list)) throw new HelperOpError("failed", "unexpected skills.sh shape");
  const results: SkillsSearchResult["results"] = [];
  for (const raw of list) {
    if (results.length >= SKILL_LIMITS.results) break;
    if (!isRecord(raw)) continue;
    const name = text(raw.name, SKILL_LIMITS.name);
    if (name === "") continue;
    const { installs } = raw;
    results.push({
      name,
      source: text(raw.source, SKILL_LIMITS.source),
      installs:
        typeof installs === "number" && Number.isSafeInteger(installs) && installs >= 0 ? installs : null,
      url: httpsUrl(raw.url),
    });
  }
  return results;
}

/**
 * Sends the owner's query to skills.sh (15 s, 1 MiB) and keeps clipped names, sources, counts and `https:` links (M7R113).
 * No header, no cookie, no redirect; a failure's own text never leaves (the detail is a fixed phrase).
 */
export function createSearchOp(
  fetchImpl: typeof fetch = strictFetch,
  options: { readonly timers?: SearchTimers; readonly timeoutMs?: number } = {},
): HelperOp<z.infer<(typeof HELPER_OPS)["skills.search"]["params"]>, SkillsSearchResult> {
  const timers = options.timers ?? realTimers;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  return {
    params: HELPER_OPS["skills.search"].params,
    run: async (params, ctx: HelperContext) => {
      const controller = new AbortController();
      let expired = false;
      const timer = timers.setTimeout(() => {
        expired = true;
        controller.abort();
      }, timeoutMs);
      const cancel = () => controller.abort();
      if (ctx.signal.aborted) cancel();
      else ctx.signal.addEventListener("abort", cancel, { once: true });
      try {
        const url = `${SEARCH_URL}?${new URLSearchParams({ q: params.query, limit: String(SKILL_LIMITS.results) })}`;
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new HelperOpError("failed", "skills.sh answered with an error status");
        }
        const body = await readCapped(response, SEARCH_MAX_BYTES);
        if (body === null) throw new HelperOpError("failed", "skills.sh answer over the size cap");
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new HelperOpError("failed", "skills.sh answer is not JSON");
        }
        return { results: parseResults(parsed) };
      } catch (error) {
        if (error instanceof HelperOpError) throw error;
        throw new HelperOpError("failed", expired ? "skills.sh timed out" : "skills.sh request failed");
      } finally {
        timers.clearTimeout(timer);
        ctx.signal.removeEventListener("abort", cancel);
      }
    },
  };
}

export const skillsSearchOp = defineOp(createSearchOp());

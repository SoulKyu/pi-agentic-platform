import { SkillsSearchResult } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { HelperContext } from "../ops.ts";
import {
  createSearchOp,
  SEARCH_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SEARCH_URL,
  type SearchTimers,
} from "./skills-search.ts";

const ctx = { signal: new AbortController().signal } as unknown as HelperContext;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? "other",
  );

/** Timers the test fires by hand: nothing waits. */
function fakeTimers() {
  const scheduled: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const timers: SearchTimers = {
    setTimeout: (run, ms) => {
      const entry = { run, ms, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout: (handle) => void ((handle as { cleared: boolean }).cleared = true),
  };
  return { timers, scheduled };
}

const RECORDED = {
  query: "web",
  searchType: "fuzzy",
  skills: [
    {
      id: "vercel-labs/agent-skills/web-design-guidelines",
      name: "web-design-guidelines",
      installs: 1234,
      source: "vercel-labs/agent-skills",
    },
    { id: "o/r/x", name: "x", installs: "many", source: "o/r", url: "https://skills.sh/o/r/x" },
    { id: "o/r/evil", name: "evil", installs: 5, source: "o/r", url: "javascript:alert(1)" },
    { id: "o/r/http", name: "http", installs: 5, source: "o/r", url: "http://skills.sh/o/r/http" },
    { id: "o/r/data", name: "data", installs: -3, source: "o/r", url: "data:text/html,<b>x" },
  ],
  count: 5,
};

describe("skills.search (M7R113)", () => {
  it("asks skills.sh once with the query, parses the recorded shape and drops every URL that is not https", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const op = createSearchOp(async (url, init) => (seen.push({ url: String(url), init }), json(RECORDED)));
    const out = await op.run({ query: "web design" }, ctx);
    expect(seen).toHaveLength(1);
    const asked = new URL(seen[0]?.url as string);
    expect(`${asked.origin}${asked.pathname}`).toBe(SEARCH_URL);
    expect(asked.searchParams.get("q")).toBe("web design");
    expect(seen[0]?.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(SkillsSearchResult.safeParse(out).success).toBe(true);
    expect(out.results).toEqual([
      { name: "web-design-guidelines", source: "vercel-labs/agent-skills", installs: 1234, url: null },
      { name: "x", source: "o/r", installs: null, url: "https://skills.sh/o/r/x" },
      { name: "evil", source: "o/r", installs: 5, url: null },
      { name: "http", source: "o/r", installs: 5, url: null },
      { name: "data", source: "o/r", installs: null, url: null },
    ]);
  });

  it("clips untrusted text: control and bidi characters go, names and sources are cut, 20 results at most", async () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({
      name: `n${i}\u202E\u0007${"z".repeat(400)}`,
      source: `o/r${"s".repeat(400)}`,
      installs: 1,
      url: `https://skills.sh/${"p".repeat(5000)}`,
    }));
    const out = await createSearchOp(async () => json({ skills: hits })).run({ query: "q" }, ctx);
    expect(out.results).toHaveLength(20);
    expect(SkillsSearchResult.safeParse(out).success).toBe(true);
    expect(out.results[0]?.name).toBe(`n0${"z".repeat(126)}`);
    expect(out.results[0]?.url).toBeNull();
  });

  it("skips entries that are not objects or have no name", async () => {
    const out = await createSearchOp(async () =>
      json({ skills: [null, 3, { source: "o/r" }, { name: "ok" }] }),
    ).run({ query: "q" }, ctx);
    expect(out.results).toEqual([{ name: "ok", source: "", installs: null, url: null }]);
  });

  it("fails on an error status, a body that is not JSON, and a shape without a list, with no remote text", async () => {
    for (const bad of [
      new Response("boom", { status: 500 }),
      new Response("<html>", { status: 200 }),
      json({ nothing: true }),
    ]) {
      expect(await codeOf(createSearchOp(async () => bad).run({ query: "q" }, ctx))).toBe("failed");
    }
  });

  it("gives up after 15 s on the clock it was given, aborting the request", async () => {
    const { timers, scheduled } = fakeTimers();
    let aborted = false;
    const hangs = ((_url: unknown, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        }),
      )) as unknown as typeof fetch;
    const pending = codeOf(createSearchOp(hangs, { timers }).run({ query: "q" }, ctx));
    expect(scheduled.map((t) => t.ms)).toEqual([SEARCH_TIMEOUT_MS]);
    expect(SEARCH_TIMEOUT_MS).toBe(15_000);
    scheduled[0]?.run();
    expect(await pending).toBe("failed");
    expect(aborted).toBe(true);
  });

  it("clears its timer on success", async () => {
    const { timers, scheduled } = fakeTimers();
    await createSearchOp(async () => json({ skills: [] }), { timers }).run({ query: "q" }, ctx);
    expect(scheduled.every((t) => t.cleared)).toBe(true);
  });

  it("refuses a body over 1 MiB: by its declared length without reading, and by the bytes of a stream", async () => {
    expect(SEARCH_MAX_BYTES).toBe(1024 * 1024);
    let read = false;
    const declared = new Response(
      new ReadableStream(
        {
          pull(controller) {
            read = true;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200, headers: { "content-length": String(SEARCH_MAX_BYTES + 1) } },
    );
    expect(await codeOf(createSearchOp(async () => declared).run({ query: "q" }, ctx))).toBe("failed");
    expect(read).toBe(false);

    let chunks = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const streamed = new Response(
      new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(chunk);
          if (chunks > 100) controller.close();
        },
      }),
    );
    expect(await codeOf(createSearchOp(async () => streamed).run({ query: "q" }, ctx))).toBe("failed");
    expect(chunks).toBeLessThanOrEqual(18);
  });

  it("accepts a body just under 1 MiB", async () => {
    const pad = " ".repeat(SEARCH_MAX_BYTES - 20);
    const body = new Response(`{"skills":[]}${pad}`, { status: 200 });
    expect(await createSearchOp(async () => body).run({ query: "q" }, ctx)).toEqual({ results: [] });
  });
});

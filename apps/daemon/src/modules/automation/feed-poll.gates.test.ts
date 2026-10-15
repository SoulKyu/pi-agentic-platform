import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedFetchResult } from "./feed-fetch.ts";
import { FEED_SEEN_MAX, markSeen, seenKeys } from "./feed-seen.ts";
import type { PrecheckPort } from "./precheck-step.ts";
import { parsedInput } from "./testing/bed.ts";
import { journal, ok, range, setup, state, tasks } from "./testing/feed-bed.ts";
import { deferred } from "./testing/runner-bed.ts";

afterEach(() => state.bed.dispose());

describe("the gates and the precheck (M10R68, M10R73)", () => {
  const pass: PrecheckPort["run"] = async () => ({
    verdict: "pass",
    exitCode: 0,
    durationMs: 1,
    output: "all green",
  });

  it("runs the precheck in the scheduler queue, gated, and fences its output next to the entries", async () => {
    const run = vi.fn<PrecheckPort["run"]>(pass);
    let posts = range(1, 2);
    const { poll } = setup(async () => ok(posts), { precheck: run });
    await poll();
    expect(run).not.toHaveBeenCalled();
    posts = range(1, 3);
    await poll();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ origin: "scheduler", command: "check.sh" });
    expect(run.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(tasks()[0]?.prompt).toContain("title: Post 3");
    expect(tasks()[0]?.tainted).toBe(1);
  });

  it("journals a precheck skip as a feed line, starts no task and keeps the entries new", async () => {
    let skip = true;
    const run: PrecheckPort["run"] = async () =>
      skip
        ? { verdict: "skip", exitCode: 1, durationMs: 1, output: "", detail: "nothing to do" }
        : pass({ command: "", cwd: "", env: [], triggerId: "", origin: "scheduler" });
    let posts = range(1, 2);
    const { poll } = setup(async () => ok(posts), { precheck: run });
    await poll();
    posts = range(1, 3);
    expect(await poll()).toEqual({ outcome: "done" });
    expect(journal().map((line) => [line.verdict, line.detail, line.source])).toEqual([
      ["dedup", "first poll \u00b7 2 entries", "feed"],
      ["precheck", "nothing to do", "feed"],
    ]);
    expect(tasks()).toEqual([]);
    skip = false;
    await poll();
    expect(tasks()).toHaveLength(1);
  });

  it("is retried, with nothing marked, when the signal aborts during the precheck", async () => {
    const controller = new AbortController();
    const run: PrecheckPort["run"] = async () => {
      controller.abort();
      return { verdict: "error", exitCode: null, durationMs: 0, output: "", detail: "precheck aborted" };
    };
    let posts = range(1, 2);
    const { poll } = setup(async () => ok(posts), { precheck: run });
    await poll();
    posts = range(1, 3);
    expect(await poll(controller.signal)).toEqual({ outcome: "retry", code: "deadline" });
    expect(tasks()).toEqual([]);
  });

  it("never runs the precheck for a first poll, a pause or the budget", async () => {
    const run = vi.fn<PrecheckPort["run"]>(pass);
    let posts = range(1, 2);
    const { poll, fetcher } = setup(async () => ok(posts), { precheck: run });
    await poll();
    posts = range(1, 3);
    state.bed.settings.value = AutomationSettings.parse({ paused: true });
    await poll();
    state.bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    state.bed.runs.spent.value = 5;
    await poll();
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(journal().map((line) => line.verdict)).toEqual(["dedup", "paused", "budget"]);
  });

  it("journals a pause and leaves the entries new, so they fire once the owner resumes", async () => {
    let posts = range(1, 2);
    const { poll, fetcher } = setup(async () => ok(posts));
    await poll();
    posts = range(1, 3);
    state.bed.settings.value = AutomationSettings.parse({ paused: true });
    expect(await poll()).toEqual({ outcome: "done" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(journal().map((line) => line.verdict)).toEqual(["dedup", "paused"]);
    expect(tasks()).toEqual([]);
    state.bed.settings.value = AutomationSettings.parse({});
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tasks()).toHaveLength(1);
  });

  it("journals the budget and leaves the entries new", async () => {
    let posts = range(1, 2);
    const { poll, fetcher } = setup(async () => ok(posts));
    await poll();
    posts = range(1, 3);
    state.bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    state.bed.runs.spent.value = 5;
    expect(await poll()).toEqual({ outcome: "done" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(journal().map((line) => line.verdict)).toEqual(["dedup", "budget"]);
    state.bed.runs.spent.value = 0;
    await poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tasks()).toHaveLength(1);
  });
});

describe("a poll cut short or overtaken (M10R73)", () => {
  it("retries with `deadline` when the signal aborts during the fetch, marking nothing", async () => {
    const controller = new AbortController();
    const pending = deferred<FeedFetchResult>();
    let posts = range(1, 2);
    let hang = false;
    const { poll } = setup((_url, signal) => {
      if (!hang) return Promise.resolve(ok(posts));
      signal.addEventListener("abort", () =>
        pending.resolve({ ok: false, code: "feed_timeout", retry: true }),
      );
      return pending.promise;
    });
    await poll();
    posts = range(1, 3);
    hang = true;
    const running = poll(controller.signal);
    controller.abort();
    expect(await running).toEqual({ outcome: "retry", code: "deadline" });
    hang = false;
    await poll();
    expect(tasks()).toHaveLength(1);
  });

  it("retries with `deadline` when the fetch finished after the signal aborted", async () => {
    const controller = new AbortController();
    let posts = range(1, 2);
    const { poll } = setup(async () => {
      controller.abort();
      return ok(posts);
    });
    expect(await poll(controller.signal)).toEqual({ outcome: "retry", code: "deadline" });
    expect(journal()).toEqual([]);
    posts = [];
    expect(await poll()).toEqual({ outcome: "done" });
  });

  it("stops the fetch in flight when the poller is stopped", async () => {
    const seen: AbortSignal[] = [];
    const { poll, poller } = setup((_url, signal) => {
      seen.push(signal);
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ ok: false, code: "feed_timeout", retry: true })),
      );
    });
    const running = poll();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    poller.stop();
    expect(await running).toEqual({ outcome: "retry", code: "deadline" });
    expect(seen[0]?.aborted).toBe(true);
  });

  it("journals `changed` and marks nothing when the trigger was saved during the fetch", async () => {
    let posts = range(1, 2);
    let edit: (() => void) | null = null;
    const { poll, trigger } = setup(async () => {
      edit?.();
      return ok(posts);
    });
    await poll();
    posts = range(1, 3);
    edit = () => {
      const view = state.bed.triggers.view(state.bed.owner(), trigger.id);
      state.bed.triggers.update(state.bed.owner(), {
        triggerId: trigger.id,
        baseRevision: view.revision,
        input: parsedInput({
          name: "renamed",
          enabled: true,
          source: { type: "feed", url: "https://example.com/feed.xml", everyMinutes: 60 },
          execution: { cwd: state.bed.folder },
          prompt: "New posts:\n{{payload}}",
        }),
      });
      edit = null;
    };
    await poll();
    expect(journal().map((line) => [line.verdict, line.detail])).toEqual([
      ["dedup", "first poll · 2 entries"],
      ["error", "changed"],
    ]);
    expect(tasks()).toEqual([]);
    await poll();
    expect(tasks()).toHaveLength(1);
  });

  it("does not write a baseline when the trigger was saved during the first fetch", async () => {
    let edit = true;
    const { poll, trigger } = setup(async () => {
      if (edit) {
        edit = false;
        const view = state.bed.triggers.view(state.bed.owner(), trigger.id);
        state.bed.triggers.update(state.bed.owner(), {
          triggerId: trigger.id,
          baseRevision: view.revision,
          input: parsedInput({
            name: "renamed",
            enabled: true,
            source: { type: "feed", url: "https://example.org/b.xml", everyMinutes: 60 },
            execution: { cwd: state.bed.folder },
            prompt: "{{payload}}",
          }),
        });
      }
      return ok(range(1, 4));
    });
    await poll();
    expect(journal().map((line) => [line.verdict, line.detail])).toEqual([["error", "changed"]]);
    await poll();
    expect(journal().at(-1)).toMatchObject({ verdict: "dedup", detail: "first poll · 4 entries" });
  });
});

describe("a fetch or a parse that fails", () => {
  it("fails a refusal with its code and journals it", async () => {
    const { poll } = setup(async () => ({ ok: false, code: "feed_address", retry: false }));
    expect(await poll()).toEqual({ outcome: "fail", code: "feed_address" });
    expect(journal()).toEqual([{ verdict: "error", detail: "feed_address", source: "feed" }]);
  });

  it("retries a network error", async () => {
    const { poll } = setup(async () => ({ ok: false, code: "feed_status_503", retry: true }));
    expect(await poll()).toEqual({ outcome: "retry", code: "feed_status_503" });
    expect(journal()).toEqual([{ verdict: "error", detail: "feed_status_503", source: "feed" }]);
  });

  it("fails a body that is not a feed", async () => {
    const { poll } = setup(async () => ({
      ok: true,
      body: "<html></html>",
      finalUrl: "https://example.com/",
    }));
    expect(await poll()).toEqual({ outcome: "fail", code: "not_a_feed" });
    expect(journal()).toEqual([{ verdict: "error", detail: "not_a_feed", source: "feed" }]);
  });

  it("fails a fetch that throws, as a retry that names no content", async () => {
    const { poll } = setup(async () => {
      throw new Error("secret https://example.com/feed?token=abc");
    });
    expect(await poll()).toEqual({ outcome: "retry", code: "feed_error" });
    expect(JSON.stringify(state.bed.logs)).not.toContain("token=abc");
  });
});

describe("the log and the span (M10R77)", () => {
  it("logs closed fields, never the address path or the body", async () => {
    let posts = range(1, 2);
    const { poll, spans } = setup(async () => ok(posts));
    await poll();
    posts = range(1, 3);
    await poll();
    const line = state.bed.logs.find((entry) => entry.msg === "feed_fetch");
    expect(line).toBeDefined();
    expect(Object.keys(line ?? {}).sort()).toEqual(
      expect.arrayContaining(["bytes", "code", "durationMs", "status", "triggerId"]),
    );
    const text = JSON.stringify(state.bed.logs);
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("Post 3");
    expect(spans).toHaveLength(2);
    for (const span of spans)
      for (const value of Object.values(span.attrs as Record<string, unknown>))
        expect(typeof value === "number" || /^[a-z0-9_.-]{1,32}$/.test(String(value))).toBe(true);
  });
});

describe("the seen set (M10R76)", () => {
  it("holds at most 1000 keys per trigger and drops the oldest", () => {
    setup(async () => ok([]));
    const id = "t-bounded";
    state.bed.db.run(
      "INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, revision, created_at, updated_at) VALUES ($id, 'u1', 'x', 0, 'feed', '{}', '/', 1, 1, 1)",
      { id },
    );
    const key = (index: number) => index.toString(16).padStart(64, "0");
    for (let batch = 0; batch < 12; batch++)
      markSeen(
        state.bed.db,
        id,
        Array.from({ length: 100 }, (_, index) => key(batch * 100 + index)),
        batch + 1,
      );
    const kept = seenKeys(
      state.bed.db,
      id,
      Array.from({ length: 1200 }, (_, index) => key(index)),
    );
    expect(FEED_SEEN_MAX).toBe(1000);
    expect(kept.size).toBe(1000);
    expect(kept.has(key(1199))).toBe(true);
    expect(kept.has(key(0))).toBe(false);
  });
});

import { AutomationSettings, methods, type TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDryRun } from "./dry-run.ts";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => {
  vi.unstubAllGlobals();
  bed.dispose();
});

function setup() {
  bed = createRunnerBed();
  const dry = createDryRun({
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    store: bed.engine.store,
    gates: bed.engine.gates,
    settings: { automation: (ownerId) => bed.settings.owners.get(ownerId) ?? bed.settings.value },
  });
  return { dry };
}
const input = (over: Record<string, unknown> = {}, exec: Record<string, unknown> = {}): TriggerInput =>
  parsedInput({
    ...manualInput(bed.folder),
    ...over,
    execution: { cwd: bed.folder, ...exec },
  });
const counts = () => ({
  tasks: bed.db.get<{ n: number }>("SELECT count(*) AS n FROM tasks")?.n,
  fires: bed.db.get<{ n: number }>("SELECT count(*) AS n FROM trigger_fires")?.n,
  outbox: bed.db.get<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n,
  audit: bed.db.get<{ n: number }>("SELECT count(*) AS n FROM audit")?.n,
});
const fenceIds = (prompt: string) => [...prompt.matchAll(/id="([0-9a-f]{12})"/g)].map((match) => match[1]);

describe("dry-run (M10R64)", () => {
  it("writes nothing: no task, no journal line, no effect, no audit row, no session", async () => {
    const { dry } = setup();
    const trigger = bed.trigger(input({ prompt: "Check {{payload}}" }));
    const before = counts();
    const result = await dry.run(bed.owner(), { triggerId: trigger.id, payload: "sample" });
    expect(result.verdict).toBe("fire");
    expect(result.tokens).toBe("none");
    expect(counts()).toEqual(before);
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
  });

  it("renders the exact prompt with the sample payload fenced under a fresh id each time", async () => {
    const { dry } = setup();
    const trigger = bed.trigger(input({ prompt: "Check {{payload}}" }));
    const first = await dry.run(bed.owner(), { triggerId: trigger.id, payload: "disk is full" });
    const second = await dry.run(bed.owner(), { triggerId: trigger.id, payload: "disk is full" });
    expect(first.prompt).toMatch(/^Check <untrusted source="manual" id="[0-9a-f]{12}">\ndisk is full\n/);
    expect(fenceIds(first.prompt)).toHaveLength(2);
    expect(fenceIds(first.prompt)[0]).not.toBe(fenceIds(second.prompt)[0]);
  });

  it("fences a webhook trigger's sample as webhook and a feed trigger's as feed", async () => {
    const { dry } = setup();
    const hook = bed.webhook();
    const feed = bed.trigger(
      input({
        name: "Feed",
        source: { type: "feed", url: "https://example.com/feed.xml" },
        prompt: "News {{payload}}",
      }),
    );
    expect((await dry.run(bed.owner(), { triggerId: hook.id, payload: "x" })).prompt).toContain(
      '<untrusted source="webhook"',
    );
    expect((await dry.run(bed.owner(), { triggerId: feed.id, payload: "x" })).prompt).toContain(
      '<untrusted source="feed"',
    );
  });

  it("is tainted with a payload and not without; edits run unasked only for auto-accept-edits listing edit or write", async () => {
    const { dry } = setup();
    const trigger = bed.trigger(
      input({ prompt: "Check" }, { mode: "auto-accept-edits", tools: ["read", "edit"] }),
    );
    const withPayload = await dry.run(bed.owner(), { triggerId: trigger.id, payload: "x" });
    const without = await dry.run(bed.owner(), { triggerId: trigger.id });
    expect(withPayload.profile).toEqual({
      preset: "full",
      mode: "auto-accept-edits",
      tainted: true,
      editsUnasked: true,
    });
    expect(without.profile).toEqual({
      preset: "full",
      mode: "auto-accept-edits",
      tainted: false,
      editsUnasked: true,
    });
    expect(without.tools).toEqual(["read", "edit"]);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ mode: "auto-accept-edits", tools: ["read", "grep"] }, false],
      [{ mode: "auto-accept-edits", tools: ["write"] }, true],
      [{ mode: "supervised", tools: ["read", "edit"] }, false],
      [{ mode: "read-only", tools: ["read", "write"] }, false],
    ];
    for (const [exec, unasked] of cases) {
      const result = await dry.run(bed.owner(), { draft: input({}, exec) });
      expect([exec, result.profile.editsUnasked]).toEqual([exec, unasked]);
    }
  });

  it("reports the mode a webhook trigger would run under: supervised by default, the owner's choice kept", async () => {
    const { dry } = setup();
    const hook = bed.webhook();
    expect((await dry.run(bed.owner(), { triggerId: hook.id })).profile).toMatchObject({
      mode: "supervised",
    });
    const chosen = await dry.run(bed.owner(), {
      draft: input({ source: { type: "webhook" } }, { mode: "auto-accept-edits" }),
    });
    expect(chosen.profile.mode).toBe("auto-accept-edits");
  });

  it("answers the folder, the budget and, for a feed trigger, that nothing was fetched and no request was made", async () => {
    const { dry } = setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    bed.runs.spent.value = 1.25;
    bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd: 5 });
    const feed = bed.trigger(
      input({ name: "Feed", source: { type: "feed", url: "https://example.com/feed.xml" } }),
    );
    const result = await dry.run(bed.owner(), { triggerId: feed.id });
    expect(result).toMatchObject({
      feed: "not_fetched",
      cwd: feed.cwd,
      budget: { spentUsd: 1.25, budgetUsd: 5 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const manual = bed.trigger(input({ name: "Plain" }));
    expect((await dry.run(bed.owner(), { triggerId: manual.id })).feed).toBeNull();
  });

  it("makes invalid_cwd a reason, not a throw, and still shows the prompt", async () => {
    const { dry } = setup();
    const result = await dry.run(bed.owner(), {
      draft: input({ prompt: "Hello" }, { cwd: "/nonexistent/for/pap" }),
    });
    expect(result.verdict).toBe("skip");
    expect(result.reasons).toEqual(["invalid_cwd"]);
    expect(result.cwd).toBe("/nonexistent/for/pap");
    expect(result.prompt).toBe("Hello");
  });

  it("lists the gates as they stand: paused, over budget for a token, a full queue", async () => {
    const { dry } = setup();
    const trigger = bed.trigger();
    expect((await dry.run(bed.owner(), { triggerId: trigger.id })).reasons).toEqual([]);
    bed.settings.value = AutomationSettings.parse({ paused: true, dailyBudgetUsd: 1 });
    bed.runs.spent.value = 1;
    expect(await dry.run(bed.owner(), { triggerId: trigger.id })).toMatchObject({
      verdict: "skip",
      reasons: ["paused"],
    });
    expect((await dry.run(bed.token(), { triggerId: trigger.id })).reasons).toEqual(["paused", "budget"]);
    bed.settings.value = AutomationSettings.parse({});
    for (let queued = 0; queued < 20; queued += 1)
      bed.engine.fire(trigger.id, trigger.revision, {
        ownerId: "u1",
        source: "manual",
        payload: null,
        dedupKey: null,
        title: "t",
        detail: null,
        gated: false,
        gates: { exemptDisabled: true },
        retry: null,
      });
    expect((await dry.run(bed.owner(), { triggerId: trigger.id })).reasons).toEqual(["queue_full"]);
  });

  it("answers not_found for another owner's trigger, and bad_request for neither a trigger nor a draft", async () => {
    const { dry } = setup();
    const trigger = bed.trigger();
    await expect(dry.run(bed.other(), { triggerId: trigger.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(dry.run(bed.owner(), {})).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses a draft that fails TriggerInput at the method's decoder (bad_request at the dispatcher)", () => {
    setup();
    const params = methods["automation.dryRun"].params;
    expect(params.safeParse({ draft: { name: "" } }).success).toBe(false);
    expect(params.safeParse({ draft: input() }).success).toBe(true);
    expect(params.safeParse({}).success).toBe(false);
    expect(params.safeParse({ triggerId: "t1", payload: "x".repeat(65_537) }).success).toBe(false);
  });
});

describe("the dry-run of a precheck (B6)", () => {
  const withPrecheck = (over: Record<string, unknown> = {}) =>
    input(over, { precheck: "make check", env: ["HOME_DIR"] });
  const removed = { verdict: "error", exitCode: null, durationMs: 0, output: "precheck_removed" };

  it("answers a stored precheck as removed for a browser caller, a token and a draft, and runs nothing", async () => {
    const { dry } = setup();
    const trigger = bed.trigger(withPrecheck());
    for (const params of [
      { triggerId: trigger.id },
      { draft: withPrecheck() },
      { triggerId: trigger.id, draft: withPrecheck({ prompt: "A different prompt" }) },
    ])
      for (const caller of [bed.owner(), bed.token()]) {
        const result = await dry.run(caller, params);
        expect(result.precheck).toEqual(removed);
        expect(result).toMatchObject({ verdict: "skip", reasons: ["precheck_error"] });
      }
  });

  it("answers null when the trigger has no precheck", async () => {
    const { dry } = setup();
    const trigger = bed.trigger();
    expect((await dry.run(bed.owner(), { triggerId: trigger.id })).precheck).toBeNull();
  });
});

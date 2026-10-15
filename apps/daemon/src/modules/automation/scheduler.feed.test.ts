import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedFetchResult } from "./feed-fetch.ts";
import { createFeedPoller } from "./feed-poll.ts";
import { createScheduler } from "./scheduler.ts";
import { createTriggerStore } from "./store.ts";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

const MINUTE = 60_000;
let bed: RunnerBed;
afterEach(() => bed.dispose());

const rss = (...titles: string[]): FeedFetchResult => ({
  ok: true,
  body: `<rss><channel>${titles.map((title) => `<item><title>${title}</title><guid>${title}</guid></item>`).join("")}</channel></rss>`,
  finalUrl: "https://example.com/feed.xml",
});

function setup(options: { enabled?: boolean; everyMinutes?: number; readOnly?: boolean } = {}) {
  bed = createRunnerBed();
  let answer = rss("a", "b");
  const fetch = vi.fn(async (): Promise<FeedFetchResult> => answer);
  const poller = createFeedPoller({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    triggers: bed.triggers,
    settings: { automation: () => bed.settings.value },
    gates: bed.engine.gates,
    fire: bed.engine.fire,
    fetch,
  });
  bed.outbox.register("feed.poll", poller.handler);
  const make = () =>
    createScheduler({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      triggers: bed.triggers,
      store: createTriggerStore(bed.db),
      fire: bed.engine.fire,
      readOnly: options.readOnly ?? false,
      outbox: bed.outbox,
    });
  const scheduler = make();
  bed.onTriggerChange(() => scheduler.refresh());
  scheduler.start();
  const { trigger } = bed.triggers.create(
    bed.owner(),
    parsedInput({
      name: "k8s blog",
      enabled: options.enabled ?? true,
      source: { type: "feed", url: "https://example.com/feed.xml", everyMinutes: options.everyMinutes ?? 60 },
      execution: { cwd: bed.folder },
      prompt: "{{payload}}",
    }),
  );
  return { scheduler, fetch, trigger, make, setAnswer: (next: FeedFetchResult) => void (answer = next) };
}
const polls = () =>
  bed.db.all<{ status: string; dedup_key: string }>(
    "SELECT status, dedup_key FROM outbox WHERE kind = 'feed.poll' ORDER BY id",
  );
const nextFire = (id: string) =>
  bed.db.get<{ next_fire_at: number | null }>("SELECT next_fire_at FROM triggers WHERE id = $id", { id })
    ?.next_fire_at;
const tasks = () => bed.db.all<{ prompt: string }>("SELECT prompt FROM tasks");

describe("feed triggers in the scheduler (M10R73)", () => {
  it("polls a new trigger at once, with a receipt, and plans the next poll", async () => {
    const { fetch, trigger } = setup();
    const created = bed.clock.now();
    expect(polls()).toEqual([{ status: "pending", dedup_key: `feed:${trigger.id}:${created}` }]);
    expect(nextFire(trigger.id)).toBe(created + 60 * MINUTE);
    await bed.outbox.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(polls()[0]?.status).toBe("done");
  });

  it("polls again every interval, and fires only the entries that are new", async () => {
    const { fetch, setAnswer } = setup();
    await bed.outbox.drain();
    expect(tasks()).toEqual([]);
    setAnswer(rss("c", "a", "b"));
    await bed.clock.advance(60 * MINUTE);
    await bed.outbox.drain();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]?.prompt).toContain("title: c");
    await bed.clock.advance(60 * MINUTE);
    await bed.outbox.drain();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(tasks()).toHaveLength(1);
  });

  it("does not poll again for the same occurrence after a restart", async () => {
    const { make, scheduler } = setup();
    scheduler.stop();
    const again = make();
    again.start();
    again.stop();
    expect(polls()).toHaveLength(1);
  });

  it("refuses a second effect for the same receipt, as when a crash lost the stored next poll", async () => {
    const { trigger, scheduler } = setup();
    const created = bed.clock.now();
    bed.db.run("UPDATE triggers SET next_fire_at = $at WHERE id = $id", { at: created, id: trigger.id });
    scheduler.refresh();
    expect(polls()).toHaveLength(1);
    expect(nextFire(trigger.id)).toBe(created + 60 * MINUTE);
  });

  it("polls once after a long stop, not once per missed interval", async () => {
    const { scheduler, trigger } = setup();
    await bed.outbox.drain();
    scheduler.stop();
    await bed.clock.advance(10 * 60 * MINUTE);
    const again = scheduler;
    again.start();
    expect(polls()).toHaveLength(2);
    expect(nextFire(trigger.id)).toBe(bed.clock.now() + 60 * MINUTE);
    again.stop();
  });

  it("arms nothing for a disabled trigger, and nothing after it is deleted", async () => {
    const { scheduler, trigger } = setup({ enabled: false });
    expect(polls()).toEqual([]);
    expect(nextFire(trigger.id)).toBeNull();
    scheduler.stop();
    expect(bed.clock.pending()).toBe(0);
  });

  it("stops its timer on stop()", async () => {
    const { scheduler } = setup();
    expect(bed.clock.pending()).toBe(1);
    scheduler.stop();
    expect(bed.clock.pending()).toBe(0);
  });

  it("polls nothing in read-only mode", async () => {
    const { fetch } = setup({ readOnly: true });
    await bed.outbox.drain();
    expect(polls()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a trigger saved again is polled again, as a first poll for a new address", async () => {
    const { trigger, fetch } = setup();
    await bed.outbox.drain();
    await bed.clock.advance(5 * MINUTE);
    const view = bed.triggers.view(bed.owner(), trigger.id);
    bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: view.revision,
      input: parsedInput({
        name: "k8s blog",
        enabled: true,
        source: { type: "feed", url: "https://example.org/other.xml", everyMinutes: 120 },
        execution: { cwd: bed.folder },
        prompt: "{{payload}}",
      }),
    });
    await bed.outbox.drain();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(nextFire(trigger.id)).toBe(bed.clock.now() + 120 * MINUTE);
    expect(tasks()).toEqual([]);
  });
});

import { vi } from "vitest";
import type { Settlement } from "../../../kernel/outbox/index.ts";
import { createFeedPoller, createPrecheckStep, type FeedFetchResult, type PrecheckPort } from "../index.ts";
import { parsedInput } from "./bed.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./runner-bed.ts";

/** The bed of the test in progress: a test file ends it with `state.bed.dispose()`. */
export const state: { bed: RunnerBed } = { bed: undefined as unknown as RunnerBed };

const DAY = 86_400_000;
export const START = Date.UTC(2026, 9, 14, 12);

export interface Post {
  readonly title: string;
  readonly at?: number;
  readonly summary?: string;
}
export const post = (index: number, extra: Partial<Post> = {}): Post => ({
  title: `Post ${index}`,
  at: START - (100 - index) * DAY,
  ...extra,
});
const rssOf = (posts: readonly Post[]): string =>
  `<rss><channel>${posts
    .map(
      (entry) =>
        `<item><title>${entry.title}</title><link>https://example.com/${encodeURIComponent(entry.title)}</link><guid>${entry.title}</guid>` +
        `${entry.at === undefined ? "" : `<pubDate>${new Date(entry.at).toUTCString()}</pubDate>`}` +
        `<description>${entry.summary ?? `About ${entry.title}`}</description></item>`,
    )
    .join("")}</channel></rss>`;
export const ok = (posts: readonly Post[]): FeedFetchResult => ({
  ok: true,
  body: rssOf(posts),
  finalUrl: "https://example.com/feed.xml",
});
export const range = (from: number, to: number): Post[] =>
  Array.from({ length: to - from + 1 }, (_, index) => post(from + index));

export type Fetch = (url: string, signal: AbortSignal) => Promise<FeedFetchResult>;
interface Options {
  /** The precheck command's runner (the port); the trigger then has a precheck command. */
  readonly precheck?: PrecheckPort["run"];
  readonly enabled?: boolean;
}

export function setup(fetch: Fetch, options: Options = {}) {
  state.bed = createRunnerBed({ startAt: START });
  const fetcher = vi.fn(fetch);
  const spans: Array<{ outcome: unknown; attrs: unknown }> = [];
  const make = () =>
    createFeedPoller({
      db: state.bed.db,
      clock: state.bed.clock,
      logger: state.bed.logger,
      triggers: state.bed.triggers,
      settings: {
        automation: (ownerId) => state.bed.settings.owners.get(ownerId) ?? state.bed.settings.value,
      },
      gates: state.bed.engine.gates,
      fire: state.bed.engine.fire,
      fetch: fetcher,
      precheck: options.precheck
        ? createPrecheckStep({
            db: state.bed.db,
            clock: state.bed.clock,
            logger: state.bed.logger,
            settings: {
              automation: (ownerId) => state.bed.settings.owners.get(ownerId) ?? state.bed.settings.value,
            },
            gates: state.bed.engine.gates,
            triggers: state.bed.triggers,
            precheck: { run: options.precheck },
          })
        : undefined,
      span: () => ({ end: (outcome, attrs) => void spans.push({ outcome, attrs }) }),
    });
  const { trigger } = state.bed.triggers.create(
    state.bed.owner(),
    parsedInput({
      name: "k8s blog",
      enabled: options.enabled ?? true,
      source: { type: "feed", url: "https://example.com/feed.xml", everyMinutes: 60 },
      execution: { cwd: state.bed.folder, ...(options.precheck ? { precheck: "check.sh" } : {}) },
      prompt: "New posts:\n{{payload}}",
    }),
  );
  const poller = make();
  const poll = (signal?: AbortSignal, as = poller): Promise<Settlement> =>
    as.handler({ triggerId: trigger.id }, effectContext(signal));
  return { trigger, poller, poll, fetcher, spans, make };
}

export const journal = () =>
  state.bed.db.all<{ verdict: string; detail: string | null; source: string }>(
    "SELECT verdict, detail, source FROM trigger_fires ORDER BY id",
  );
export const tasks = () =>
  state.bed.db.all<{
    prompt: string;
    tainted: number;
    detail: string | null;
    origin: string;
    policy: string;
  }>("SELECT prompt, tainted, detail, origin, policy FROM tasks ORDER BY created_at, id");

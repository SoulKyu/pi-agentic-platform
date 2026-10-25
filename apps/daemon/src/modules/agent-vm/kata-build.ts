import { LAUNCH_LIMITS, type VmdRequest, VmdImageProgress } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { ImageObserver } from "../../kernel/launches.ts";
import type { Logger } from "../../kernel/logger.ts";
import { keepSet, MAX_KEEP } from "./image-prune.ts";
import type { VmdClient } from "./vmd-client.ts";

type Build = Extract<VmdRequest, { op: "image.build" }>;

/** How often the build's last line is looked at while a layer builds. */
export const PROGRESS_POLL_MS = 2_000;

export interface KataBuildDeps {
  readonly client: VmdClient;
  readonly clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  /** Masks the owner's values and the well-known secret formats in a build line. */
  readonly redact: (line: string) => Promise<string>;
  readonly logger: Logger;
  readonly buildOnce: (request: Build) => Promise<void>;
  /** The tag of the profile prepared last, if any. */
  readonly profileTag: () => string | null;
  readonly runningTags: () => readonly string[];
  readonly held: () => ReadonlyArray<{ readonly agentId: string; readonly image: string }>;
  /** The newest image each agent was asked for since this boot (the prune keeps it). */
  readonly latest: ReadonlyMap<string, string>;
}

/** The two vmd-facing steps of an image build: the layers pap-vmd does not hold yet, and the prune after them. */
export function createKataBuild(deps: KataBuildDeps) {
  const { client, clock, logger, buildOnce, latest, redact } = deps;
  /** The tags each box's launch is building now (the log reads their tails). */
  const watching = new Map<string, readonly string[]>();

  /** A tag's progress; any `VmdError` (an older pap-vmd answers `bad_request`) or an odd answer is no sign of life. */
  async function progressOf(tag: string, tail: boolean): Promise<VmdImageProgress | null> {
    try {
      const answer = VmdImageProgress.safeParse(
        await client.request({ op: "image.progress", tag, ...(tail ? { tail: true as const } : {}) }),
      );
      return answer.success ? answer.data : null;
    } catch {
      return null;
    }
  }

  async function redacted(line: string): Promise<string | null> {
    try {
      return await redact(line);
    } catch {
      return null;
    }
  }

  /** Every 2 s until stopped: the last line of the first tag that builds, redacted, told to the launch. */
  function pollLines(tags: readonly string[], observe: ImageObserver): () => void {
    let stopped = false;
    let timer: TimerHandle | null = null;
    const tick = async (): Promise<void> => {
      for (const tag of tags) {
        const progress = await progressOf(tag, false);
        if (progress?.building !== true || progress.last === null) continue;
        const line = await redacted(progress.last.line);
        // A throwing observer is no line: the build and the poll go on (A4 M4).
        try {
          if (line !== null && !stopped) observe.line?.(line, progress.last.at);
        } catch (error) {
          logger.warn("launch_line_failed", { err: error });
        }
        break;
      }
      if (!stopped) timer = clock.setTimeout(() => void tick(), PROGRESS_POLL_MS);
    };
    timer = clock.setTimeout(() => void tick(), PROGRESS_POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
    };
  }

  /** "Show the log": the kept lines of the tags the box's launch is building, redacted; empty when none builds. */
  async function tailOf(boxId: string): Promise<string[]> {
    const lines: string[] = [];
    for (const tag of watching.get(boxId) ?? []) {
      const progress = await progressOf(tag, true);
      for (const line of progress?.tail ?? []) {
        const clean = await redacted(line);
        if (clean !== null) lines.push(clean);
      }
    }
    return lines.slice(-LAUNCH_LIMITS.logLines);
  }

  /** Final review I2, under `exclusive`: removes the images nothing needs. A failure is logged, never thrown into a launch. */
  async function prune(baseTag: string, built: readonly string[]): Promise<void> {
    const keep = keepSet({
      base: baseTag,
      profile: deps.profileTag(),
      built,
      latest,
      running: deps.runningTags(),
      held: deps.held(),
    });
    if (keep.length > MAX_KEEP) {
      logger.warn("agent_image_prune_skipped", { count: keep.length });
      return;
    }
    try {
      const answer = (await client.request({ op: "image.prune", keep })) as { removed?: unknown } | null;
      const removed = Array.isArray(answer?.removed) ? answer.removed.length : 0;
      logger.info("agent_image_pruned", { removed, kept: keep.length });
    } catch (error) {
      logger.warn("agent_image_prune_failed", { err: error });
    }
  }

  /** Under `exclusive`, with the tree of `profile` on disk: the layers of `wanted` that pap-vmd does not hold yet. */
  async function buildLayers(
    profile: { readonly tag: string },
    baseTag: string,
    wanted: string,
    systemPackages: readonly string[],
    built: ReadonlySet<string>,
    /** The launch that waits for this build and the box it is for: its image step shows the last line. */
    view?: { readonly observe: ImageObserver | undefined; readonly boxId: string },
  ): Promise<void> {
    const todo = [profile.tag, wanted].filter((tag, at, all) => !built.has(tag) && all.indexOf(tag) === at);
    const builds = todo.length > 0;
    const stop = view ? watch(view, todo) : undefined;
    try {
      await buildMissing(profile, baseTag, wanted, systemPackages, built);
    } finally {
      stop?.();
    }
    if (builds) await prune(baseTag, [profile.tag, wanted]);
  }

  function watch(
    view: { observe: ImageObserver | undefined; boxId: string },
    tags: readonly string[],
  ): () => void {
    watching.set(view.boxId, tags);
    const stopLines = view.observe?.line ? pollLines(tags, view.observe) : undefined;
    return () => {
      stopLines?.();
      watching.delete(view.boxId);
    };
  }

  async function buildMissing(
    profile: { readonly tag: string },
    baseTag: string,
    wanted: string,
    systemPackages: readonly string[],
    built: ReadonlySet<string>,
  ): Promise<void> {
    if (!built.has(profile.tag))
      await buildOnce({
        op: "image.build",
        layer: "profile",
        tag: profile.tag,
        from: baseTag,
        aptPackages: [],
        upgrade: false,
      });
    if (wanted !== profile.tag && !built.has(wanted))
      await buildOnce({
        op: "image.build",
        layer: "agent",
        tag: wanted,
        from: profile.tag,
        aptPackages: [...new Set(systemPackages)].sort(),
        upgrade: false,
      });
  }

  return { prune, buildLayers, tailOf, watch };
}

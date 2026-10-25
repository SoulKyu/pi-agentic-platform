import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_VM_PROTOCOL, PapError, type VmdRequest } from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { ImageObserver } from "../../kernel/launches.ts";
import type { Logger } from "../../kernel/logger.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import { createKataBuild } from "./kata-build.ts";
import { agentLayerTag, treeDigest } from "./image-inputs.ts";
import { createImagePolicy, type ImagePolicy, type RunningImage } from "./image-policy.ts";
import type { ImageEntries, WrittenEntry } from "./pick-map.ts";
import type { Inputs } from "./profile-job.ts";
import { type ProfileRunner, threadProfileRunner } from "./profile-runner.ts";
import { OWNER_SECRETS_CAP_NOTICE, OwnerSecretsError, type OwnerSecrets } from "./owner-secrets.ts";
import { type KnownSecrets, PROFILE_SECRET_NOTICE, ProfileSecretError } from "./secret-scan.ts";
import { papErrorOf, type VmdClient, VmdError } from "./vmd-client.ts";

/** An edit of Pi's settings or packages reaches a new start within this long (the preparation copies and hashes the packages). */
export const PROFILE_TTL_MS = 30_000;
/** The root-owned bundle changes only with `pap vm setup`: its digest is read again at most this often. */
export const BASE_TTL_MS = 3_600_000;
const BASE_TAG_PREFIX = "pap-agent-base-";
/** The profile changes under a start this many times in a row: the start fails `conflict` and the next one tries again. */
const RESOLVE_TRIES = 3;
export const REBUILD_NOTICE =
  "Cet agent doit être reconstruit pour cette version de pap ; il redémarrera quand l'image sera prête.";

const Listing = z.object({ tags: z.array(z.string()) });

export interface KataImagesDeps {
  readonly client: VmdClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly papHome: string;
  /** The owner's Pi agent folder: the profile is cut from it by allowlist. */
  readonly agentDir: string;
  /** pap-vmd's root-owned bundle (`/opt/pap-vm/agent-bundle`): the base tag follows its bytes. */
  readonly bundleRoot: string;
  /** `docker.io/library/node@sha256:...` from `vm-assets.json`. */
  readonly nodeImage: string;
  /** The ISO week of the last successful base rebuild, kept across restarts. */
  readonly weekFile: string;
  /** The owner's secrets, collected at each build (T15b); a plain list names no auth.json-only provider. A rejection refuses the build. */
  readonly secrets: () => KnownSecrets | OwnerSecrets | Promise<KnownSecrets | OwnerSecrets>;
  readonly entries: Pick<ImageEntries, "record" | "forget" | "held">;
  /** Masks a build line before the launch shows it (the owners' values, then the well-known formats); default: the well-known formats only. */
  readonly redact?: (line: string) => Promise<string>;
  /** Runs one profile preparation; the default is a worker thread (I4), tests run it in process. */
  readonly profileRunner?: ProfileRunner;
  /** Posts once into the agent's thread (a late binding: the sessions come after this). */
  readonly notice: (agentId: string, text: string) => void;
}

export interface KataImages {
  /**
   * The image tag an agent's VM starts with, built first when it must be (spec §6): a VM that runs keeps its image while a
   * new one builds, an agent with none waits for it. The agent's package picks follow the image it gets (AVM-E44). A `thread`
   * spawn into a thread VM that already runs answers that VM's tag at once, with no preparation and no new pairs (M4).
   */
  resolve(
    agentId: string,
    systemPackages: readonly string[],
    kind: "thread" | "isolated",
    /** The launch this serves: told when nothing is built, when the build queues, and which tag builds. */
    observe?: ImageObserver,
    /** The box whose "Show the log" reads this build, when it is not `agentId` (a project's rebuild builds under its own key). */
    logBox?: string,
  ): Promise<string>;
  /** The agent's thread VM runs on `tag`. */
  started(agentId: string, tag: string, protocol?: number): void;
  stopped(agentId: string): void;
  /** The agent is deleted: its notice memory and its package pairs go. */
  forget(agentId: string): void;
  /** The digest the base tag follows: the installed bundle's (the tag's suffix), read again when `fresh`. */
  installedDigest(fresh?: boolean): string;
  /** The same digest over another bundle folder (the daemon's own), so the two compare. */
  digestOf(dir: string): string;
  /**
   * Once a week (the caller ticks): rebuilds the base with `apt-get upgrade`. A success is on disk before it is used (a restart
   * does not rebuild every image twice). A failure is logged and retried after an hour by the policy's `retryAt`, which is in
   * memory: a restarted daemon has no wait left, so the first tick after boot (one hour after it; the start of an agent builds
   * a missing base on its own) tries again. The profile and agent images wait behind pap-vmd's build queue.
   */
  upgradeBaseIfDue(): Promise<void>;
  /** The lines BuildKit printed for the image the box's launch is building now, redacted; empty when none builds. */
  buildLog(boxId: string): Promise<string[]>;
}

type Build = Extract<VmdRequest, { op: "image.build" }>;

interface Prepared {
  readonly key: string;
  readonly tag: string;
  readonly written: readonly WrittenEntry[];
  readonly at: number;
}

export function createKataImages(deps: KataImagesDeps): KataImages {
  const { client, clock, logger } = deps;
  const policy: ImagePolicy = createImagePolicy({ clock, lastBaseWeek: readWeek(deps.weekFile) });
  const running = new Map<string, RunningImage>();
  let baseCache: { tag: string; at: number } | null = null;
  let baseFlight: Promise<void> | null = null;
  let prepared: Prepared | null = null;
  /** The last preparation that finished with its inputs fingerprinted (I4): an unchanged profile is not prepared again. */
  let lastGood: { prepared: Prepared; inputs: Inputs } | null = null;
  /** The newest image each agent was asked for since this boot (the prune keeps it). */
  const latest = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve();
  const profileOut = join(deps.papHome, "vm", "build", "profile", "pi-agent");

  let busy = 0;
  /**
   * One at a time: the profile's tree under `$PAP_HOME/vm/build/profile` is what pap-vmd copies, so a new preparation must not
   * replace it while a build of the old one reads it.
   */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      busy += 1;
      try {
        return await work();
      } finally {
        busy -= 1;
      }
    };
    const run = tail.then(guarded, guarded);
    // The chain goes on after a failure; the caller of `run` is the one who sees it.
    tail = run.catch(() => {});
    return run;
  }

  async function listed(): Promise<Set<string>> {
    const answer = Listing.safeParse(await client.request({ op: "image.list" }));
    if (!answer.success) throw new VmdError("protocol");
    return new Set(answer.data.tags);
  }

  /** pap-vmd joins a second build of a tag already building, so the daemon only waits. */
  const buildOnce = (request: Build): Promise<void> => client.request(request).then(() => undefined);

  /** The digest of a bundle folder, salted like the base tag's: the installed one and the daemon's own compare under it. */
  const bundleDigest = (dir: string): string => treeDigest(dir, `pap-base-2\0${deps.nodeImage}`);

  function baseTagNow(fresh = false): string {
    if (!fresh && baseCache !== null && clock.now() - baseCache.at < BASE_TTL_MS) return baseCache.tag;
    try {
      const tag = `${BASE_TAG_PREFIX}${bundleDigest(deps.bundleRoot)}`;
      baseCache = { tag, at: clock.now() };
      return tag;
    } catch (error) {
      logger.warn("agent_vm_bundle_unreadable", { err: error });
      throw new PapError("sandbox_unavailable");
    }
  }

  /** The week is on disk before `baseUpgradeFinished` makes the new `baseKey` live: a restart finds the tags that were built. */
  async function buildBase(baseTag: string, week: string | null): Promise<void> {
    let ok = false;
    try {
      await buildOnce({
        op: "image.build",
        layer: "base",
        tag: baseTag,
        from: deps.nodeImage,
        aptPackages: [],
        upgrade: true,
      });
      if (week !== null) writeWeek(deps.weekFile, week);
      ok = true;
    } finally {
      if (week !== null) policy.baseUpgradeFinished(week, ok);
    }
  }

  const { prune, buildLayers, tailOf, watch } = createKataBuild({
    client,
    clock,
    logger,
    redact: deps.redact ?? ((line) => Promise.resolve(scrubKnownSecrets(line).text)),
    buildOnce,
    profileTag: () => prepared?.tag ?? null,
    runningTags: () => [...running.values()].map((one) => one.tag),
    held: () => deps.entries.held(),
    latest,
  });

  /** `view`: the launch that waits for the base, whose image step shows the build's last line (R14). */
  async function ensureBase(
    baseTag: string,
    view?: { readonly observe: ImageObserver | undefined; readonly boxId: string },
  ): Promise<void> {
    if ((await listed()).has(baseTag)) return;
    baseFlight ??= buildBase(baseTag, policy.claimBaseUpgrade()).finally(() => void (baseFlight = null));
    const stop = view ? watch(view, [baseTag]) : undefined;
    try {
      await baseFlight;
    } finally {
      stop?.();
    }
  }

  /** Under `exclusive`: the profile as the allowlist cuts it now (the tree on disk is always the last one made here). */
  async function prepare(baseTag: string, agentId: string): Promise<Prepared> {
    const key = policy.baseKey(baseTag);
    const last = lastGood;
    prepared = null;
    lastGood = null;
    mkdirSync(dirname(profileOut), { recursive: true, mode: 0o700 });
    try {
      const owned = await deps.secrets();
      const { secrets, providers } = "secrets" in owned ? owned : { secrets: owned, providers: [] };
      const outcome = await (deps.profileRunner ?? threadProfileRunner)({
        agentDir: deps.agentDir,
        out: profileOut,
        secrets,
        papHome: deps.papHome,
        baseTag: key,
        providers,
        nowMs: clock.now(),
        previous: last?.inputs ?? null,
      });
      if (outcome.kind === "secret") throw new ProfileSecretError(outcome.file);
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind === "unchanged" && last !== null) {
        prepared = { ...last.prepared, at: clock.now() };
        lastGood = last;
        return prepared;
      }
      if (outcome.kind !== "made") throw new Error("the profile preparation answered nothing usable");
      const { made } = outcome;
      if (made.skipped.length > 0) logger.info("agent_profile_skipped", { count: made.skipped.length });
      prepared = { key, tag: made.tag, written: made.written, at: clock.now() };
      lastGood = outcome.inputs === null ? null : { prepared, inputs: outcome.inputs };
      return prepared;
    } catch (error) {
      if (error instanceof ProfileSecretError) {
        logger.warn("agent_profile_secret", { file: error.file });
        deps.notice(agentId, PROFILE_SECRET_NOTICE);
      } else {
        logger.warn("agent_profile_refused", { err: error });
        if (error instanceof OwnerSecretsError && error.reason === "too_many")
          deps.notice(agentId, OWNER_SECRETS_CAP_NOTICE);
      }
      throw new PapError("config_invalid");
    }
  }

  /**
   * The profile now: the one prepared less than `PROFILE_TTL_MS` ago, or, while a build holds the tree (minutes), the last one
   * prepared whatever its age, so a running agent's next worker never waits for a build behind it; else a new preparation.
   */
  function profileNow(baseTag: string, agentId: string): Promise<Prepared> {
    const key = policy.baseKey(baseTag);
    const usable = (stale: boolean): Prepared | null =>
      prepared !== null && prepared.key === key && (stale || clock.now() - prepared.at < PROFILE_TTL_MS)
        ? prepared
        : null;
    const now = usable(false) ?? (busy > 0 ? usable(true) : null);
    if (now !== null) return Promise.resolve(now);
    return exclusive(async () => usable(false) ?? (await prepare(baseTag, agentId)));
  }

  /** The agent keeps running on its image: the build goes on behind, and a failure is only logged. */
  function buildBehind(
    agentId: string,
    profile: Prepared,
    baseTag: string,
    wanted: string,
    sys: readonly string[],
  ) {
    void exclusive(async () => {
      // A newer preparation replaced the tree this build needs: a later start builds the newer one.
      if (prepared?.tag !== profile.tag) return;
      await buildLayers(profile, baseTag, wanted, sys, await listed());
    }).catch((error: unknown) => logger.warn("agent_image_build_failed", { agentId, err: error }));
  }

  /** One pass of `resolve`; `null`: the profile was replaced before its build ran, ask again. */
  async function resolveOnce(
    agentId: string,
    sys: readonly string[],
    baseTag: string,
    observe?: ImageObserver,
    logBox: string = agentId,
  ): Promise<string | null> {
    const profile = await profileNow(baseTag, agentId);
    const wanted = agentLayerTag(profile.tag, sys);
    latest.set(agentId, wanted);
    const built = await listed();
    const decision = policy.decide({ agentId, wanted, running: running.get(agentId) ?? null, built });
    if (decision.action === "refuse") {
      logger.warn("agent_image_protocol", {
        agentId,
        running: decision.running,
        expected: decision.expected,
      });
      deps.notice(agentId, REBUILD_NOTICE);
      buildBehind(agentId, profile, baseTag, wanted, sys);
      throw new PapError("sandbox_unavailable");
    }
    if (decision.action === "build-then-use" && decision.use !== null) {
      if (decision.notice !== null) deps.notice(agentId, decision.notice);
      buildBehind(agentId, profile, baseTag, wanted, sys);
      observe?.skipped(); // the launch runs on the image that is there
      return decision.use;
    }
    const tag = decision.action === "use" ? decision.tag : decision.build;
    if (built.has(tag)) observe?.skipped();
    else {
      // `busy` builds hold the queue: this one is that many places back.
      const queued = busy > 0;
      if (queued) observe?.waiting(busy);
      const done = await exclusive(async () => {
        if (queued) observe?.waiting(null);
        if (prepared?.tag !== profile.tag) return false;
        observe?.building(wanted);
        await buildLayers(profile, baseTag, wanted, sys, await listed(), { observe, boxId: logBox });
        return true;
      });
      if (!done) return null;
    }
    // The launch gets this image: its package picks map through the pairs recorded for it.
    deps.entries.record(agentId, tag, profile.written);
    return tag;
  }

  return {
    async resolve(agentId, systemPackages, kind, observe, logBox = agentId) {
      const live = kind === "thread" ? running.get(agentId) : undefined;
      if (live !== undefined) {
        observe?.skipped();
        return live.tag;
      }
      try {
        const baseTag = baseTagNow();
        await ensureBase(baseTag, { observe, boxId: logBox });
        for (let attempt = 0; attempt < RESOLVE_TRIES; attempt += 1) {
          const tag = await resolveOnce(agentId, systemPackages, baseTag, observe, logBox);
          if (tag !== null) return tag;
        }
        throw new PapError("conflict");
      } catch (error) {
        throw papErrorOf(error);
      }
    },
    started: (agentId, tag, protocol = AGENT_VM_PROTOCOL) => void running.set(agentId, { tag, protocol }),
    stopped: (agentId) => void running.delete(agentId),
    forget(agentId) {
      running.delete(agentId);
      latest.delete(agentId);
      policy.forget(agentId);
      deps.entries.forget(agentId);
    },
    installedDigest: (fresh) => baseTagNow(fresh).slice(BASE_TAG_PREFIX.length),
    digestOf: bundleDigest,
    buildLog: tailOf,
    async upgradeBaseIfDue() {
      try {
        const baseTag = baseTagNow();
        const week = policy.claimBaseUpgrade();
        if (week === null) return;
        if (baseFlight !== null) {
          // A start is building the base right now (with the upgrade): this week's claim is given back.
          policy.baseUpgradeFinished(week, false);
          return;
        }
        baseFlight = buildBase(baseTag, week).finally(() => void (baseFlight = null));
        await baseFlight;
        await exclusive(() => prune(baseTag, []));
      } catch (error) {
        logger.warn("agent_vm_base_upgrade_failed", { err: error });
      }
    },
  };
}

function readWeek(file: string): string | null {
  try {
    const week = readFileSync(file, "utf8").trim();
    return /^\d{4}-W\d{2}$/.test(week) ? week : null;
  } catch {
    return null;
  }
}

/** Atomic: the new week is complete on disk or the old one stays. */
function writeWeek(file: string, week: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${week}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

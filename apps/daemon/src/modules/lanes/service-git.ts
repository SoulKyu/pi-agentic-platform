import type { ForgeKind } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { WorktreesPort } from "../worktrees/index.ts";
import { createLaneFacts } from "./facts.ts";
import { createCommitter } from "./git-ops.ts";
import type { LaneNotices } from "./notices.ts";
import { createPrs } from "./pr.ts";
import { createMutex, createPusher } from "./push.ts";
import { createRemoteFacts } from "./remote-facts.ts";
import type { LaneConfig } from "./preview.ts";
import type { LaneLock } from "./lane-lock.ts";
import type { LaneRow, LanesStore } from "./store.ts";
import type { Outward } from "./view.ts";

export interface GitServicesDeps {
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: LanesStore;
  readonly worktrees: Pick<WorktreesPort, "gitDirOf">;
  readonly config: Partial<Pick<LaneConfig, "forgeLine">>;
  readonly notices: LaneNotices;
  readonly lock: (laneId: string) => LaneLock;
  readonly audit: Pick<AuditPort, "append"> | undefined;
  readonly allowFile: boolean;
  readonly forgeFor: ((kind: ForgeKind) => Forge | null) | undefined;
  readonly readOnly: boolean;
  /** The lane changed: its view goes out on the lane stream. */
  publish(laneId: string): void;
}

/** The lane's facts, its remote and forge, pull requests, commit and push: the parts of the service that talk to git and the forge. */
export function createGitServices(deps: GitServicesDeps) {
  const { logger, store, publish } = deps;
  const gitDirOf = deps.worktrees.gitDirOf;
  const facts = createLaneFacts({
    git: deps.git,
    clock: deps.clock,
    logger,
    store,
    gitDirOf,
    changed: publish,
  });
  const remote = createRemoteFacts({
    git: deps.git,
    logger,
    allowFile: deps.allowFile,
    store,
    gitDirOf,
    forgeOverride: async (lane) => deps.config.forgeLine?.(lane.ownerId, lane.projectRoot),
    changed: publish,
  });
  const mutex = createMutex();
  const prs = createPrs({
    store,
    forgeFor: (kind) => deps.forgeFor?.(kind) ?? null,
    facts,
    remote,
    mutex,
    audit: deps.audit ?? { append: () => undefined },
    clock: deps.clock,
    logger,
    publish,
    readOnly: deps.readOnly,
  });
  const outward = (row: LaneRow): Outward =>
    row.state === "archived"
      ? { pr: prs.viewFor(row), forge: null, remote: null, pushRemote: null }
      : { pr: prs.viewFor(row), ...remote.view(row.id) };
  const refreshFacts = (laneId: string): Promise<void> =>
    facts.refresh(laneId).catch((error: unknown) => logger.warn("lane_facts_failed", { err: error }));
  const committer = createCommitter({
    store,
    git: deps.git,
    gitDirOf,
    lock: deps.lock,
    notices: deps.notices,
    refresh: refreshFacts,
    publish,
    logger,
    readOnly: deps.readOnly,
  });
  const pusher = createPusher({
    store,
    git: deps.git,
    gitDirOf,
    allowFile: deps.allowFile,
    audit: deps.audit ?? { append: () => undefined },
    mutex,
    refreshFacts,
    refreshRemote: remote.refresh,
    publish,
    logger,
    readOnly: deps.readOnly,
  });
  return { facts, remote, prs, outward, refreshFacts, committer, pusher };
}

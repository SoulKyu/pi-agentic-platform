import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Caller,
  type IssueView,
  LANE_LIMITS,
  LaneTitle,
  PapError,
  type ParamsOf,
  type ResultOf,
  slugOf,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { BoundaryConfig } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { issueUrl } from "../../kernel/forge/remote.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { TrustPort } from "../trust/index.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import { laneFolder, type WorktreesPort, WorktreeFailure } from "../worktrees/index.ts";
import type { CopyLinkInput } from "./copy-link.ts";
import { resolveBase } from "./create-git.ts";
import { checkedIssue } from "./issue.ts";
import { chooseBranches, newFanoutId, pickIds, renderedPrompt } from "./fanout.ts";
import type { LaneNotices } from "./notices.ts";
import type { LanePathsIndex } from "./paths.ts";
import type { LaneConfig } from "./preview.ts";
import { openLog } from "./script-log.ts";
import type { ScriptRunner } from "./scripts.ts";
import { createInheritTrust } from "./trust-inherit.ts";
import type { FailedReason, LaneRow, LanesStore, NewLane } from "./store.ts";

/** Copy and link, together, get this long (M9R24, Task 4 review); the lane then fails with `prepare` and is undone. */
export const PREPARE_DEADLINE_MS = 120_000;

interface IssuePorts {
  readonly policy: Pick<PolicyPort, "markTainted">;
  readonly trust: Pick<TrustPort, "status" | "inherit">;
  readonly audit: Pick<AuditPort, "append"> | undefined;
}

export interface CreateDeps {
  readonly store: LanesStore;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `$PAP_HOME`: lane folders are under it and setup logs in `lanes/<laneId>/`. */
  readonly home: string;
  readonly worktrees: WorktreesPort;
  readonly config: Pick<LaneConfig, "preview" | "approvedScript">;
  readonly scripts: Pick<ScriptRunner, "run">;
  readonly paths: LanePathsIndex;
  readonly notices: LaneNotices;
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly denyFolders: readonly string[];
  readonly readOnly: boolean;
  readonly isMember: (userId: string) => boolean;
  /** Throws when the filesystem is too full (M9R117). */
  diskFloor(path: string): undefined;
  copyLink(input: CopyLinkInput): Promise<{ skipped: number }>;
  /** The lane changed: its view goes out on the lane stream. */
  publish(laneId: string): void;
  /** Resolves once the lane's setup is not `queued` or `running` any more. */
  awaitSetup(laneId: string): Promise<void>;
  /** The sessions port, once the daemon has bound it. */
  sessions(): SessionsLanePort | undefined;
  /**
   * What an issue lane and trust inheritance need once the daemon has bound them: the policy port marks the primary
   * session tainted (M9R82), the audit records it, and Pi's trust gives a ready worktree its project's decision (M9R83).
   */
  ports(): IssuePorts | undefined;
  /** A fan-out group exists: its event goes out on the lane stream before the lanes' views. */
  publishFanout(ownerId: string, fanoutId: string): void;
  /** A lane id is a slug and 4 random hex digits; tests make them known. */
  readonly random?: (bytes: number) => Buffer;
}

export interface LaneCreator {
  create(caller: Caller, params: ParamsOf<"lanes.create">): Promise<ResultOf<"lanes.create">>;
  /** Every background create has ended. */
  settled(): Promise<void>;
  /** No new create; waits for those running (a 120 s `worktree add` can outlive a stop, MC3). */
  stop(): Promise<void>;
}

const SETUP_DONE_OK = new Set(["ok", "none", "unapproved"]);

/** Opens the lane's session in its worktree with its model; the first one becomes the primary session (M9R38). */
export async function openSession(
  deps: Pick<CreateDeps, "store" | "notices" | "sessions">,
  row: LaneRow,
  caller: Caller,
): Promise<string> {
  const sessions = deps.sessions();
  if (!sessions) throw new PapError("capacity");
  const { sessionId, modelRefused } = await sessions.create(caller, row.worktree, row.model);
  if (deps.store.get(row.id)?.primarySessionId === null) deps.store.setPrimarySession(row.id, sessionId);
  if (modelRefused) deps.notices.add(row.id, "model_refused");
  return sessionId;
}

export function createLaneCreator(deps: CreateDeps): LaneCreator {
  const { store, clock, logger } = deps;
  const inflight = new Set<Promise<void>>();
  const inheritTrust = createInheritTrust({ git: deps.git, logger, trust: () => deps.ports()?.trust });
  let closing = false;

  /** Lines for the person in the lane's setup log: counts and codes, never git's or a script's own words. */
  function appendLog(laneId: string, lines: readonly string[]): void {
    if (lines.length === 0) return;
    try {
      const sink = openLog(deps.home, laneId, "setup", logger, true);
      for (const line of lines) sink.write(Buffer.from(`${line}\n`));
      sink.close();
    } catch (error) {
      logger.warn("lane_setup_log_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  async function failLane(lane: LaneRow, error: unknown): Promise<void> {
    let reason: FailedReason = "prepare";
    if (error instanceof WorktreeFailure) {
      // The worktree module undid its own step (and the branch rule) before it rejected.
      reason = error.step;
    } else {
      logger.warn("lane_prepare_failed", { laneId: lane.id, err: error });
      try {
        await deps.worktrees.undo(lane.worktree);
      } catch (undoError) {
        logger.error("lane_undo_failed", { laneId: lane.id, err: undoError });
      }
    }
    store.setState(lane.id, "failed", { failedReason: reason });
    deps.paths.rebuild();
    deps.publish(lane.id);
  }

  /** Copy and link under one deadline; the copy is told to stop at the deadline and is awaited, so undo never races it. */
  async function prepare(lane: LaneRow, plan: Plan, gitDir: string, lines: string[]): Promise<number> {
    const controller = new AbortController();
    const timer = clock.setTimeout(
      () => controller.abort(new Error("prepare deadline")),
      PREPARE_DEADLINE_MS,
    );
    try {
      const { skipped } = await deps.copyLink({
        root: plan.root,
        worktree: lane.worktree,
        gitDir,
        copy: plan.copy,
        link: plan.link,
        git: deps.git,
        boundary: deps.boundary,
        deny: deps.deny,
        denyFolders: deps.denyFolders,
        log: (line) => void lines.push(line),
        diskFloor: deps.diskFloor,
        signal: controller.signal,
      });
      return skipped;
    } finally {
      clock.clearTimeout(timer);
    }
  }

  /** A browser lane runs its approved setup; a token's waits for the owner's click, whatever text it has (M9R110). */
  async function setupOf(lane: LaneRow, waitForSetup: boolean): Promise<void> {
    const ref = {
      id: lane.id,
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
    };
    try {
      if (lane.createdBy === "token") {
        const found = await deps.config.approvedScript(lane.ownerId, lane.projectRoot, "setup");
        store.setSetupState(lane.id, found.ok || found.reason === "unapproved" ? "pending" : "none");
        deps.publish(lane.id);
        return;
      }
      await deps.scripts.run(ref, "setup", { keepLog: true });
    } catch (error) {
      logger.warn("lane_setup_not_started", { laneId: lane.id, err: error });
      return;
    }
    if (waitForSetup) await deps.awaitSetup(lane.id);
  }

  /** The session that will read the issue is tainted before it does (M9R82, ADR 0020); a failure here sends no prompt. */
  function taintForIssue(caller: Caller, lane: LaneRow, sessionId: string, issue: IssueView): void {
    const ports = deps.ports();
    if (ports === undefined) throw new PapError("capacity");
    ports.policy.markTainted(lane.ownerId, sessionId);
    ports.audit?.append({
      ownerId: lane.ownerId,
      actor: caller.kind === "token" ? "token" : "user",
      ...(caller.credentialId ? { actorId: caller.credentialId } : {}),
      kind: "policy",
      reason: "tainted_issue",
      sessionId,
      detail: { laneId: lane.id, forge: issue.forge, number: issue.number },
    });
  }

  async function startPrimary(caller: Caller, lane: LaneRow, plan: Plan): Promise<void> {
    let sessionId: string | null = null;
    try {
      sessionId = await openSession(deps, lane, caller);
      if (plan.issue !== undefined) taintForIssue(caller, lane, sessionId, plan.issue);
      await deps
        .sessions()
        ?.prompt(caller, sessionId, plan.prompt ?? `# ${lane.title}\n\n${lane.description}`);
    } catch (error) {
      const code = error instanceof PapError ? error.code : "unknown";
      logger.warn("lane_session_failed", { laneId: lane.id, code, started: sessionId !== null });
      appendLog(lane.id, [
        `primary session ${sessionId === null ? "not started" : "got no first prompt"}: ${code}`,
      ]);
      deps.notices.add(lane.id, "session_failed");
    }
    deps.publish(lane.id);
  }

  /** Phase 2 (M9R33): the worktree, copy and link, ready, active, then setup, then the primary session. */
  async function background(caller: Caller, lane: LaneRow, plan: Plan): Promise<void> {
    const lines: string[] = [];
    let skipped: number;
    try {
      await deps.worktrees.create(lane.worktree);
      const gitDir = deps.worktrees.gitDirOf(lane.worktree);
      if (gitDir === undefined) throw new Error("the worktree has no recorded git dir");
      skipped = await prepare(lane, plan, gitDir, lines);
      await deps.worktrees.ready(lane.worktree);
    } catch (error) {
      appendLog(lane.id, lines);
      return failLane(lane, error);
    }
    appendLog(lane.id, lines);
    store.setState(lane.id, "active");
    if (skipped > 0) deps.notices.add(lane.id, "copy_skipped", skipped);
    deps.publish(lane.id);
    if (closing) return;

    // The worktree is ready, so Pi's decision is written before any session opens in it (M9R83).
    await inheritTrust({
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
      baseOid: lane.baseOid,
      by: caller,
      root: plan.root,
    });
    if (closing) return;
    await setupOf(lane, plan.waitForSetup);
    if (closing) return;
    const setup = store.get(lane.id)?.setupState;
    if (plan.waitForSetup && !(setup !== undefined && SETUP_DONE_OK.has(setup))) return;
    await startPrimary(caller, lane, plan);
  }

  async function create(caller: Caller, params: ParamsOf<"lanes.create">): Promise<ResultOf<"lanes.create">> {
    if (closing) throw new PapError("capacity");
    if (deps.readOnly) throw new PapError("read_only");
    if (deps.isMember(caller.userId)) throw new PapError("forbidden"); // lanes are host worktrees (M14)
    const title = LaneTitle.safeParse(params.title);
    if (!title.success) throw new PapError("bad_request");

    // `not_found` for a folder that is not the caller's project root, or not a main checkout (like lanes.preview).
    const preview = await deps.config.preview(caller, params.projectRoot);
    if (!preview.repo) throw new PapError("not_found");
    // A link may point only where the owner meant it, whoever sent the issue (M9R82): judged here again.
    const issueRef = params.issue === undefined ? undefined : checkedIssue(params.issue, preview);
    const root = await realpath(params.projectRoot).catch(() => {
      throw new PapError("not_found");
    });
    const base = await resolveBase(deps.git, root, params.baseRef, preview.current);
    const count = params.models.length;
    const fanout = count > 1;
    const prompt =
      fanout || params.issue !== undefined
        ? renderedPrompt({ title: title.data, description: params.description, issue: params.issue })
        : undefined;
    const branches = await chooseBranches(
      deps.git,
      root,
      params.branch,
      preview.config.branchPrefix,
      slugOf(title.data),
      count,
    );

    const ids = pickIds(count, title.data, (id) => store.get(id) !== undefined, deps.random);
    const paths = ids.map((id) => laneFolder(deps.home, id));
    // The git awaits above may have outlived a stop: from here to the background start nothing awaits (M9-RT-23).
    if (closing) throw new PapError("capacity");
    try {
      deps.diskFloor(dirname(paths[0] as string));
    } catch (error) {
      throw error instanceof PapError ? error : new PapError("capacity");
    }

    const fanoutId = fanout ? newFanoutId(deps.random) : null;
    const source: NewLane["source"] =
      params.issue === undefined || issueRef === undefined
        ? { kind: "description" }
        : { kind: "issue", forge: params.issue.forge, url: issueUrl(issueRef), number: params.issue.number };
    // One transaction (M9R81): the group and all its reservations, or nothing. The worktrees cap counts the rows already
    // reserved here, so a fan-out needs as many free slots as it has lanes (else `capacity`, nothing written).
    store.transaction(() => {
      if (fanoutId !== null) store.insertFanout(caller.userId, fanoutId, prompt as string, clock.now());
      ids.forEach((id, slot) => {
        deps.worktrees.reserve(
          caller.userId,
          {
            path: paths[slot] as string,
            workspaceId: "default",
            repoRoot: root,
            branch: branches[slot] as string,
            baseOid: base.baseOid,
            createdBranch: true,
          },
          () => {
            if (store.countOpen(caller.userId) >= LANE_LIMITS.activePerOwner)
              throw new PapError("limit_reached");
            store.insert(
              {
                id,
                ownerId: caller.userId,
                createdBy: caller.kind,
                projectRoot: params.projectRoot,
                worktree: paths[slot] as string,
                branch: branches[slot] as string,
                baseRef: base.baseRef,
                baseOid: base.baseOid,
                title: title.data,
                description: params.description,
                source,
                model: params.models[slot] ?? null,
                ...(fanoutId === null ? {} : { fanoutId, fanoutSlot: slot }),
              },
              clock.now(),
            );
          },
        );
      });
    });
    deps.paths.rebuild();
    if (fanoutId !== null) deps.publishFanout(caller.userId, fanoutId);
    const plan: Plan = {
      root,
      copy: preview.config.copy,
      link: preview.config.link,
      waitForSetup: preview.config.waitForSetup,
      ...(params.issue === undefined ? {} : { issue: params.issue }),
      ...(prompt === undefined ? {} : { prompt }),
    };
    for (const id of ids) {
      deps.publish(id);
      const lane = store.get(id) as LaneRow;
      // The answer does not wait for `worktree add`, which may take two minutes (M9-RT-23).
      // Every failure before `active` is handled inside; one after it leaves a lane whose worktree is ready, so only logs.
      const running = background(caller, lane, plan).catch((error: unknown) => {
        logger.error("lane_create_failed", { laneId: id, err: error });
      });
      const tracked = running.finally(() => inflight.delete(tracked));
      inflight.add(tracked);
    }
    return { laneIds: ids, fanoutId };
  }

  return {
    create,
    settled: async () => void (await Promise.allSettled([...inflight])),
    async stop() {
      closing = true;
      await Promise.allSettled([...inflight]);
    },
  };
}

interface Plan {
  readonly root: string;
  readonly copy: readonly string[];
  readonly link: readonly string[];
  readonly waitForSetup: boolean;
  /** An issue lane: its first prompt is the fenced issue, and its primary session starts tainted. */
  readonly issue?: IssueView;
  readonly prompt?: string;
}

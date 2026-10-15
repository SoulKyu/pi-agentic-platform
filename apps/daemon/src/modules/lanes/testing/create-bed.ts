import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Caller,
  LANE_LIMITS,
  type LaneView,
  PapError,
  type ParamsOf,
  type ScriptKind,
} from "@pap/contracts";
import type { SessionsLanePort } from "../../sessions/index.ts";
import type { TrustPort } from "../../trust/index.ts";
import { type WorktreesPort, WorktreeFailure } from "../../worktrees/index.ts";
import { testCaller } from "../../../testing/caller.ts";
import {
  createLaneConfig,
  createLanesService,
  type LanesService,
  type LanesServiceDeps,
  scriptHash,
} from "../index.ts";
import { createLanesBed, type LanesBed } from "./bed.ts";
import { createFakes, runnerOf } from "./script-fakes.ts";

export type CreateParams = ParamsOf<"lanes.create">;

/** A promise a test settles by hand. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export interface CreateBedOptions {
  /** Wraps the real git runner (a test that makes `check-ref-format` lie). */
  readonly git?: (real: LanesBed["git"], order: string[]) => LanesBed["git"];
  readonly readOnly?: boolean;
  /** Extra service deps (Task 14: the audit port, the push seam and the forge adapter). */
  readonly deps?: Partial<LanesServiceDeps>;
}

/** `lanes.create` over a real repository and database, a real script runner on fake processes, and fakes for the rest. */
export function createCreateBed(options: CreateBedOptions = {}) {
  const lb = createLanesBed();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pap-create-")));
  const order: string[] = [];
  const published: Array<{ key: string; event: { kind: string; lane?: LaneView } }> = [];
  const fakes = createFakes();
  const git = options.git ? options.git(lb.git, order) : lb.git;
  const config = createLaneConfig({ ...lb.deps, git });

  /** What the fakes do; a test replaces one to make a step wait or fail. */
  const behaviour: {
    worktreeCreate: (path: string) => Promise<void>;
    copy: (signal: AbortSignal) => Promise<{ skipped: number }>;
    /** Lines the copy step writes to the setup log. */
    copyLog: string[];
    diskFloor: (path: string) => void;
    session: () => Promise<{ sessionId: string; modelRefused: boolean }>;
    prompt: () => Promise<{ disposition: "started" }>;
    /** Archive: what the sessions, terminals and worktrees fakes answer. */
    activity: (folder: string) => { sessions: number; busy: boolean; needsInput: boolean };
    sessionIds: string[];
    tainted: Set<string>;
    /** Pi's decision for the project root, as the trust port answers it (Task 18a). */
    trustStatus: boolean | null;
    /** Marking a session tainted throws (a policy failure). */
    taintFails: boolean;
    /** What `inherit` answers. */
    trustInherit: boolean;
    terminals: number;
    /** Creations already running (worktrees `creating`) when the test starts: the worktrees cap counts them. */
    creatingOthers: number;
    /** Workers `releaseIdle` leaves alone (an open dialog, a queued message, a command in flight). */
    releaseBusy: number;
    remove: (force: boolean) => { ok: true } | { ok: false; reason: "dirty" };
    deleteBranch: boolean;
    /** Runs when the archive step of that name is reached, before it answers (a test makes a run start "just before"). */
    onStep: (step: string) => void;
  } = {
    worktreeCreate: async () => undefined,
    copy: async () => ({ skipped: 0 }),
    copyLog: [],
    diskFloor: () => undefined,
    session: async () => ({ sessionId: "sess-1", modelRefused: false }),
    prompt: async () => ({ disposition: "started" }),
    activity: () => ({ sessions: 1, busy: false, needsInput: false }),
    sessionIds: ["sess-1"],
    tainted: new Set<string>(),
    trustStatus: null,
    trustInherit: true,
    taintFails: false,
    terminals: 0,
    creatingOthers: 0,
    releaseBusy: 0,
    remove: () => ({ ok: true }),
    deleteBranch: true,
    onStep: () => undefined,
  };
  const calls = {
    remove: [] as Array<{ path: string; force: boolean }>,
    branches: [] as Array<{ repoRoot: string; branch: string }>,
    trust: [] as Array<{ ownerId: string; folder: string }>,
    inherit: [] as Array<{ ownerId: string; folder: string; from: string }>,
    markTainted: [] as Array<{ ownerId: string; sessionId: string }>,
    undo: [] as string[],
    sessions: [] as Array<{ caller: Caller; worktree: string; model: unknown }>,
    prompts: [] as Array<{ sessionId: string; text: string }>,
    copy: [] as Array<{ root: string; worktree: string; gitDir: string; denyFolders: readonly string[] }>,
    disk: [] as string[],
  };

  /** Reserved here and not yet ready or undone: the real module refuses the fifth `creating` row of an owner. */
  const creating = new Set<string>();
  const worktrees = {
    reserve(_owner: string, row: { path: string }, check: (tx: LanesBed["db"]) => void) {
      order.push("reserve");
      lb.db.transaction(() => {
        if (behaviour.creatingOthers + creating.size >= LANE_LIMITS.creatingPerOwner)
          throw new PapError("capacity");
        check(lb.db);
        creating.add(row.path);
      });
    },
    async create(path: string) {
      order.push("create");
      await behaviour.worktreeCreate(path);
      mkdirSync(path, { recursive: true });
    },
    async ready(path: string) {
      order.push("ready");
      creating.delete(path);
    },
    async undo(path: string) {
      order.push("undo");
      creating.delete(path);
      calls.undo.push(path);
    },
    gitDirOf: () => "/fake/git/dir",
    byPath: () => ({ repoRoot: lb.gb.root }),
    async remove(input: { path: string; force: boolean }) {
      order.push("remove");
      calls.remove.push(input);
      behaviour.onStep("remove");
      return behaviour.remove(input.force);
    },
    async deleteBranch(input: { repoRoot: string; branch: string }) {
      order.push("deleteBranch");
      calls.branches.push(input);
      return behaviour.deleteBranch;
    },
  } as unknown as WorktreesPort;

  const sessions = {
    async create(caller: Caller, worktree: string, model: unknown) {
      order.push("session");
      calls.sessions.push({ caller, worktree, model });
      return behaviour.session();
    },
    async prompt(_caller: Caller, sessionId: string, text: string) {
      order.push("prompt");
      calls.prompts.push({ sessionId, text });
      return behaviour.prompt();
    },
    activityIn(_ownerId: string, folder: string) {
      order.push("activityIn");
      return behaviour.activity(folder);
    },
    sessionIdsIn: () => behaviour.sessionIds,
    runState: () => ({ idle: !behaviour.activity("").busy, leafId: null }),
    releaseIn() {
      order.push("releaseIn");
      behaviour.onStep("releaseIn");
      return { released: 1, busy: behaviour.releaseBusy };
    },
    archiveIn() {
      order.push("archiveIn");
      return 1;
    },
  } as unknown as SessionsLanePort;
  const terminals = {
    runningIn() {
      order.push("terminals");
      return behaviour.terminals;
    },
  };
  const trust = {
    async status() {
      return behaviour.trustStatus;
    },
    async inherit(ownerId: string, folder: string, from: string) {
      order.push("trust.inherit");
      calls.inherit.push({ ownerId, folder, from });
      return behaviour.trustInherit;
    },
    async clear(ownerId: string, folder: string) {
      order.push("trust.clear");
      calls.trust.push({ ownerId, folder });
    },
  } as unknown as TrustPort;
  const policy = {
    sessionPolicy: (_ownerId: string, sessionId: string) => ({
      mode: "supervised" as const,
      explicit: false,
      taint: { tainted: behaviour.tainted.has(sessionId), epoch: 0 },
    }),
    markTainted(ownerId: string, sessionId: string): boolean {
      order.push("markTainted");
      if (behaviour.taintFails) throw new Error("policy down");
      calls.markTainted.push({ ownerId, sessionId });
      behaviour.tainted.add(sessionId);
      return true;
    },
  };
  const audited: Array<Parameters<NonNullable<LanesServiceDeps["audit"]>["append"]>[0]> = [];

  const bridge: { changed: (laneId: string) => void } = { changed: () => undefined };
  const runner = runnerOf({
    db: lb.db,
    clock: lb.clock,
    logger: lb.logger,
    home,
    fakes,
    approved: config.approvedScript,
    extra: { onChange: (laneId: string) => bridge.changed(laneId) },
  });
  const deps: LanesServiceDeps = {
    db: lb.db,
    git,
    clock: lb.clock,
    logger: lb.logger,
    home,
    worktrees,
    config,
    scripts: runner,
    boundary: lb.deps.boundary,
    deny: lb.deps.deny,
    denyFolders: ["/denied"],
    readOnly: options.readOnly ?? false,
    terminals,
    audit: { append: (line) => void audited.push(line) },
    diskFloor: (path) => {
      calls.disk.push(path);
      behaviour.diskFloor(path);
    },
    copyLink: async (input) => {
      order.push("copy");
      calls.copy.push({
        root: input.root,
        worktree: input.worktree,
        gitDir: input.gitDir,
        denyFolders: input.denyFolders,
      });
      for (const line of behaviour.copyLog) input.log(line);
      return behaviour.copy(input.signal ?? new AbortController().signal);
    },
    ...options.deps,
  };
  const service: LanesService = createLanesService(deps);
  bridge.changed = service.publish;
  service.bind({
    sessions,
    trust,
    policy,
    hub: {
      publish: (_stream, key, event) => void published.push({ key, event: event as never }),
      registerSnapshot: () => undefined,
    },
  });

  const browser = (): Caller => testCaller({ stepUpUntil: lb.clock.now() + 60_000 });
  const token = (): Caller => testCaller({ kind: "token" });
  const params = (over: Partial<CreateParams> = {}): CreateParams => ({
    projectRoot: lb.gb.root,
    title: "Add thing",
    description: "do it",
    models: [null],
    ...over,
  });
  const view = (laneId: string): LaneView => service.get(browser(), laneId);

  return {
    ...lb,
    home,
    order,
    published,
    fakes,
    config,
    behaviour,
    calls,
    audited,
    service,
    runner,
    browser,
    token,
    params,
    view,
    /** The one lane id a single-model create answers. */
    async create(over: Partial<CreateParams> = {}, caller: Caller = browser()): Promise<string> {
      const answer = await service.create(caller, params(over));
      return answer.laneIds[0] as string;
    },
    /** `.pi/project.yaml` of the project, and the owner's approval of the scripts in it. */
    writeConfig(text: string): void {
      mkdirSync(join(lb.gb.root, ".pi"), { recursive: true });
      writeFileSync(join(lb.gb.root, ".pi", "project.yaml"), text);
    },
    async approve(scripts: Record<ScriptKind, string | undefined>): Promise<void> {
      const wanted = (Object.entries(scripts) as Array<[ScriptKind, string | undefined]>).flatMap(
        ([kind, text]) => (text === undefined ? [] : [{ kind, sha256: scriptHash(text) }]),
      );
      const answer = await config.approveScripts(browser(), { projectRoot: lb.gb.root, scripts: wanted });
      if (!answer.ok) throw new Error("approval refused");
    },
    WorktreeFailure,
    dispose(): void {
      lb.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
export type CreateBed = ReturnType<typeof createCreateBed>;

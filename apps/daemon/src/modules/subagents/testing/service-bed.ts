import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, type PlatformError, type SubagentProfileFile } from "@pap/contracts";
import { afterEach, vi } from "vitest";
import { type Clock, createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { type Logger, silentLogger } from "../../../kernel/logger.ts";
import type { PlatformContext } from "../../platform/index.ts";
import type { RunEndEvent } from "../../runs/index.ts";
import { SUBAGENTS_MIGRATIONS } from "../index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const profileFile: SubagentProfileFile = {
  name: "scout",
  description: "Scouts",
  source: "user",
  tools: ["read", "grep"],
  model: "fast",
  prompt: "You scout.",
};
const end = (sessionId: string, status: RunEndEvent["status"] = "completed"): RunEndEvent => ({
  runId: "run-1",
  sessionId,
  ownerId: "u1",
  taskId: null,
  origin: "subagent",
  status,
  costUsd: 0,
  errorClass: null,
  limitResetAt: null,
});

export interface Options {
  enabled?: boolean;
  maxConcurrent?: number;
  admits?: boolean;
  over?: boolean;
  text?: string | null;
  childTainted?: boolean;
  parentTaskId?: string | null;
  createError?: PapError;
  promptError?: Error;
  profileError?: PapError;
  expectOrigin?: boolean;
  /** `taintedOf` answers null: the child's session is gone. */
  childGone?: boolean;
  /** `releaseIdle` answers busy this many times before it releases. */
  busyReleases?: number;
  /** `prompt` waits for `releasePrompt()` before it reaches the worker (a lane's git capture, M9R114). */
  holdPrompt?: boolean;
  /** `parentOpen` answers these, in order, then the last one for good (default: always open). */
  parentOpen?: boolean[];
  /** The agent every parent belongs to, for the quarantine cases. */
  agentOfParent?: string;
}

/** What the service is built from: the bed keeps the fakes, the test file brings the real factories (the boundaries rule). */
export interface ServiceParts<Store, Stop> {
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
  readonly store: Store;
  readonly settings: {
    subagents(ownerId: string): { readonly enabled: boolean; readonly maxConcurrent: number };
  };
  readonly profiles: { get(ownerId: string, sessionId: string, name: string): Promise<SubagentProfileFile> };
  readonly sessions: {
    admits(ownerId: string): boolean;
    createChild(input: {
      ownerId: string;
      parentSessionId: string;
      profile: { tools: readonly string[] | null; prompt: string | null; model: string | null } | null;
    }): Promise<{ sessionId: string; tainted: boolean }>;
    prompt(input: {
      ownerId: string;
      sessionId: string;
      text: string;
      stillWanted?: () => boolean;
    }): Promise<unknown>;
    parentOpen(ownerId: string, parentSessionId: string): boolean;
    abort(ownerId: string, sessionId: string): Promise<void>;
    lastText(ownerId: string, sessionId: string, max: number): Promise<string | null>;
    taintedOf(sessionId: string): boolean | null;
    releaseIdle(ownerId: string, sessionId: string): "released" | "busy" | "cold";
    changed(parentSessionId: string): void;
  };
  readonly runs: {
    onRunEnd(listener: (event: RunEndEvent) => void): () => void;
    expectOrigin(sessionId: string, expectation: { origin: string; taskId: string | null }): boolean;
    clearExpected(sessionId: string): void;
    openTaskOf(sessionId: string): string | null;
  };
  readonly agents: { over(ownerId: string, agentId: string): boolean };
  readonly stop: Stop;
}

/** The stop unit the service holds its child with, built by the test file from the real factory. */
export interface StopParts<Store> {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Store;
  readonly sessions: {
    abort(ownerId: string, sessionId: string): Promise<void>;
    agentOf(parentId: string): string | null;
  };
  readonly runs: { clearExpected(sessionId: string): void };
}

export interface Factories<Store, Service, Stop> {
  createSubagentStore(db: Db): Store;
  createSubagentStop(parts: StopParts<Store>): Stop;
  createSubagentService(parts: ServiceParts<Store, Stop>): Service;
}

export function bed<Store, Service, Stop>(factories: Factories<Store, Service, Stop>, options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pap-subagents-service-"));
  dirs.push(dir);
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, SUBAGENTS_MIGRATIONS],
    clock: createFakeClock(1),
    logger: silentLogger,
  }).db;
  const clock = createFakeClock(10_000_000);
  const store = factories.createSubagentStore(db);
  const listeners = new Set<(event: RunEndEvent) => void>();
  const calls: Array<[string, unknown]> = [];
  let childCount = 0;
  let releases = 0;
  const sent: string[] = [];
  let releasePrompt: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const sessions = {
    admits: vi.fn(() => options.admits ?? true),
    createChild: vi.fn(async (input: unknown) => {
      calls.push(["createChild", input]);
      if (options.createError) throw options.createError;
      childCount += 1;
      return { sessionId: `child-${childCount}`, tainted: options.childTainted ?? false };
    }),
    prompt: vi.fn(async (input: { sessionId: string; text: string; stillWanted?: () => boolean }) => {
      calls.push(["prompt", input]);
      if (options.promptError) throw options.promptError;
      if (options.holdPrompt) await held;
      // M10's rule: asked once, right before the prompt reaches the worker.
      if (input.stillWanted && !input.stillWanted()) return "handled" as const;
      sent.push(input.sessionId);
      return "started" as const;
    }),
    parentOpen: vi.fn(() => {
      const answers = options.parentOpen ?? [true];
      return answers.length > 1 ? (answers.shift() as boolean) : (answers[0] ?? true);
    }),
    abort: vi.fn(async (_ownerId: string, sessionId: string) => void calls.push(["abort", sessionId])),
    lastText: vi.fn(async (_ownerId: string, _childId: string, max: number) => {
      const text = options.text === undefined ? "the answer" : options.text;
      return text === null ? null : text.slice(0, max);
    }),
    taintedOf: vi.fn<(sessionId: string) => boolean | null>(() =>
      options.childGone ? null : (options.childTainted ?? false),
    ),
    releaseIdle: vi.fn<(ownerId: string, sessionId: string) => "released" | "busy" | "cold">(() => {
      releases += 1;
      return releases <= (options.busyReleases ?? 0) ? "busy" : "released";
    }),
    changed: vi.fn<(parentSessionId: string) => void>(),
  };
  const runs = {
    onRunEnd: vi.fn((listener: (event: RunEndEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
    expectOrigin: vi.fn((sessionId: string, expectation: { origin: string; taskId: string | null }) => {
      calls.push(["expectOrigin", { sessionId, ...expectation }]);
      return options.expectOrigin ?? true;
    }),
    clearExpected: vi.fn((sessionId: string) => void calls.push(["clearExpected", sessionId])),
    openTaskOf: vi.fn<(sessionId: string) => string | null>(() => options.parentTaskId ?? null),
  };
  const profiles = {
    get: vi.fn(async () => {
      if (options.profileError) throw options.profileError;
      return profileFile;
    }),
  };
  const agents = { over: vi.fn(() => options.over ?? false) };
  const stop = factories.createSubagentStop({
    clock,
    logger: silentLogger,
    store,
    sessions: { abort: sessions.abort, agentOf: () => options.agentOfParent ?? null },
    runs,
  });
  let ids = 0;
  const service = factories.createSubagentService({
    clock,
    logger: silentLogger,
    newId: () => `id-${++ids}`,
    store,
    settings: {
      subagents: () => ({ enabled: options.enabled ?? true, maxConcurrent: options.maxConcurrent ?? 2 }),
    },
    profiles,
    sessions,
    runs,
    agents,
    stop,
  });
  const ctx = (extra: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "parent",
    type: "plain",
    tainted: false,
    agentId: null,
    signal: new AbortController().signal,
    ...extra,
  });
  const finish = (sessionId: string, status?: RunEndEvent["status"]) => {
    for (const listener of [...listeners]) listener(end(sessionId, status));
  };
  const codeOf = (promise: Promise<unknown>): Promise<PlatformError | "ok"> =>
    promise.then(
      () => "ok",
      (error: { code?: PlatformError }) => error.code ?? ("other" as never),
    );
  return {
    service,
    stop,
    sent,
    releasePrompt: () => releasePrompt(),
    store,
    clock,
    sessions,
    runs,
    profiles,
    agents,
    calls,
    ctx,
    finish,
    codeOf,
    listeners,
  };
}

/** A call that has reached its wait: the child exists and was prompted. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

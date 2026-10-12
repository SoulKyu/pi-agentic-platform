import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ALL_PERMISSIONS,
  type Caller,
  type CommandInput,
  type Cursor,
  type EventFrame,
  type InitRecord,
  type WorkerRecord,
} from "@pap/contracts";
import { type Clock, createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { type Logger, silentLogger } from "../../../kernel/logger.ts";
import type { WorkerHandle } from "../../../kernel/supervisor/worker.ts";
import { createFakeWorker, type FakeWorker } from "../../../kernel/testing/fake-worker.ts";
import { createStreamHub, type StreamHub } from "../../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../../policy/index.ts";
import type { ProjectsPort } from "../../projects/index.ts";
import { createExports, type Exports, loadPiWriter, type PiWriter, SESSIONS_MIGRATIONS } from "../index.ts";
import { fakePolicyPort } from "./fake-policy.ts";
import { fakeProjectsPort } from "./fake-projects.ts";
import { sessionFileText } from "./pi-file-writers.ts";

export { sessionFileText };

/** What a fake worker does when it gets `init`. */
export type StartBehavior =
  | {
      kind: "ready";
      piId?: string;
      sessionFile?: string;
      /** Said just before `ready`. */ before?: WorkerRecord[];
      /** Pi's leaf in `ready` (default null). */
      leafId?: string | null;
      /** Pi's session name in `ready` (default null). */
      sessionName?: string | null;
    }
  | { kind: "silent" }
  | { kind: "exit70" };

export interface BedOptions {
  limits?: { maxWorkers: number; minFreeMemMb: number };
  freeMemMb?: number;
  testProviderScript?: string | null;
  /** The umask the daemon was started with; defaults to 022. */
  umask?: number;
  logger?: Logger;
  /** The policy module's port; defaults to an empty fake (`fakePolicyPort()`). */
  policy?: PolicyPort;
  /** The projects module's port; defaults to `fakeProjectsPort()`. */
  projects?: ProjectsPort;
  /** Replaces the writer of forks and clones (a test of how the service treats what it returns). */
  writer?: PiWriter;
  /** The transcript reader fails to load this many times before it loads. */
  readerFailures?: number;
  /** The idle release delay; 0 (the default) turns the release off. */
  idleMs?: number;
  /** A worker told to stop exits only when the test crashes it (`bed.spawned[i].crash(...)`). */
  holdShutdown?: boolean;
  /** By the order the workers are spawned in, from 0. */
  start?(index: number, init: InitRecord): StartBehavior | undefined;
  /**
   * How the fake worker answers a command, by type. `"held"` waits for `bed.answerHeld(index, command, reply)`.
   * `navigate_tree` and `compact` answer a success unless told otherwise.
   */
  replies?: Partial<Record<CommandInput["type"], BedReply | "held">>;
}

export interface BedReply {
  success?: boolean;
  error?: string;
  data?: unknown;
}

/** The one user of the beds: the owner of every session they make. */
export const OWNER: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };

const IDLE_STATE = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  sessionFile: "/f",
  sessionId: "s",
};

/** What a sessions service is built from. The service and store themselves are the test's own: see `Factories`. */
export interface ServiceParts<Store, Reader> {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly policy: PolicyPort;
  readonly projects: ProjectsPort;
  readonly exports: Exports;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
  readonly idleMs: number;
  readonly worker: {
    readonly agentDir: string;
    readonly papHome: string;
    readonly umask: number;
    readonly testProviderScript: string | null;
  };
  newId(): string;
  freeMemMb(): number;
  spawn(cwd: string): WorkerHandle;
  loadTranscript(): Promise<Reader>;
  loadWriter(): Promise<PiWriter>;
}

// A helper in `testing/` may import a module only through its index (the boundaries rule), so the service and the
// store come in from the test files, which sit in the module and import what they test directly.
export interface ServiceLike {
  snapshot(key: string): unknown;
  prepareSubscription(sessionId: string, caller: Caller): Promise<void>;
}

export interface Factories<Store, Reader, Service extends ServiceLike> {
  createSessionsStore(db: Db): Store;
  createSessionsService(parts: ServiceParts<Store, Reader>): Service;
  loadTranscriptReader(): Promise<Reader>;
}

/** A sessions service over a real database, a real stream hub and fake workers, in a temporary directory. */
export function createServiceBed<Store, Reader, Service extends ServiceLike>(
  factories: Factories<Store, Reader, Service>,
  options: BedOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pap-sessions-"));
  const work = join(dir, "work");
  /** A second project, for the tests that push rules to one project and not the other. */
  const otherWork = join(dir, "other-work");
  const agentDir = join(dir, "agent");
  const sessionsDir = join(agentDir, "sessions", "--w--");
  mkdirSync(work);
  mkdirSync(otherWork);
  mkdirSync(sessionsDir, { recursive: true });
  const clock: FakeClock = createFakeClock();
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  const store = factories.createSessionsStore(db);
  const hub: StreamHub = createStreamHub("e1", clock);
  const spawned: FakeWorker[] = [];
  /** The session file each worker reported in `ready`, by spawn order. It exists only once the test writes it. */
  const files: string[] = [];
  let ids = 0;
  const transcript = { loads: 0, failures: options.readerFailures ?? 0 };
  const answered = new Set<string>();
  const exportsDir = join(dir, "pap", "exports");
  const forkTmpDir = join(dir, "pap", "fork-tmp");
  const exports = createExports({ dir: exportsDir, clock, logger: options.logger ?? silentLogger });
  const projects = options.projects ?? fakeProjectsPort();
  const service = factories.createSessionsService({
    store,
    clock,
    logger: options.logger ?? silentLogger,
    hub,
    policy: options.policy ?? fakePolicyPort(),
    projects,
    exports,
    limits: options.limits ?? { maxWorkers: 4, minFreeMemMb: 0 },
    idleMs: options.idleMs ?? 0,
    worker: {
      agentDir,
      papHome: join(dir, "pap"),
      umask: options.umask ?? 0o022,
      testProviderScript: options.testProviderScript ?? null,
    },
    newId: () => `p${++ids}`,
    loadTranscript: () => {
      transcript.loads++;
      if (transcript.failures-- > 0) return Promise.reject(new Error("the SDK did not load"));
      return factories.loadTranscriptReader();
    },
    loadWriter: () =>
      options.writer
        ? Promise.resolve(options.writer)
        : loadPiWriter(forkTmpDir, { logger: options.logger ?? silentLogger }),
    freeMemMb: () => options.freeMemMb ?? 4096,
    spawn: () => {
      const index = spawned.length;
      const worker = createFakeWorker({
        clock,
        ...(options.holdShutdown ? { holdShutdown: true } : {}),
        onSend: (record, self) => {
          if (record.type !== "init") return;
          const behavior = options.start?.(index, record) ?? { kind: "ready" };
          if (behavior.kind === "silent") return;
          if (behavior.kind === "exit70") {
            queueMicrotask(() => self.crash({ code: 70, signal: null, cause: "exit_code" }));
            return;
          }
          // Pi reopens a file under the id in its header, and starts a session of its own for a draft.
          const piId =
            behavior.piId ?? (record.sessionFile ? basename(record.sessionFile, ".jsonl") : `pi-${index}`);
          const sessionFile =
            behavior.sessionFile ?? record.sessionFile ?? join(sessionsDir, `${piId}.jsonl`);
          files[index] = sessionFile;
          queueMicrotask(() => {
            for (const record of behavior.before ?? []) self.emit(record);
            self.emit({
              type: "ready",
              sessionId: piId,
              sessionFile,
              piVersion: "1.1.0",
              leafId: behavior.leafId ?? null,
              sessionName: behavior.sessionName ?? null,
            });
          });
        },
        reply: (command) => {
          const scripted = options.replies?.[command.type];
          if (scripted === "held") return undefined;
          if (scripted) return scripted;
          if (command.type === "navigate_tree") return { data: { cancelled: false, leafId: null } };
          if (command.type === "compact") return { data: { tokensBefore: 10, estimatedTokensAfter: 5 } };
          if (command.type === "prompt") return { data: { disposition: "started" } };
          if (command.type === "get_state") return { data: IDLE_STATE };
          if (command.type === "clear_queue")
            return { data: { steering: ["left"], followUp: ["after"], truncated: false } };
          return undefined;
        },
      });
      spawned.push(worker);
      return worker;
    },
  });
  hub.registerSnapshot("session", (key) => service.snapshot(key));
  return {
    dir,
    work,
    otherWork,
    /** The pending HTML exports and the directory their files are in. */
    exports,
    exportsDir,
    forkTmpDir,
    sessionsDir,
    agentDir,
    clock,
    db,
    store,
    projects,
    hub,
    service,
    spawned,
    files,
    transcript,
    /** What a client is given: `subscribe.session` prepares the read first (owner, transcript reader), then the hub builds this. */
    async snapshot(sessionId: string): Promise<ReturnType<Service["snapshot"]>> {
      await service.prepareSubscription(sessionId, OWNER);
      return service.snapshot(sessionId) as ReturnType<Service["snapshot"]>;
    },
    /** A client subscribing through the same two steps; the frames it receives collect in the returned array. */
    async subscribe(sessionId: string, after?: Cursor): Promise<EventFrame[]> {
      await service.prepareSubscription(sessionId, OWNER);
      const frames: EventFrame[] = [];
      hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "session",
        key: sessionId,
        after,
        send: (frame) => void frames.push(frame),
      });
      return frames;
    },
    /** What Pi does with the first user message: the worker's session file comes into being. */
    writePiFile(
      index: number,
      exchanges: ReadonlyArray<readonly [string, string]> = [["hi", "hello"]],
    ): string {
      const file = files[index] ?? "";
      writeFileSync(file, sessionFileText(basename(file, ".jsonl"), exchanges));
      return file;
    },
    /** Answers the first request of this type that a `"held"` reply left waiting, on the worker spawned `index`-th. */
    answerHeld(index: number, command: CommandInput["type"], reply: BedReply): void {
      const request = spawned[index]?.requests.find(
        (candidate) => candidate.type === command && !answered.has(`${index}:${candidate.id}`),
      );
      if (!request) throw new Error(`no held ${command} request on worker ${index}`);
      answered.add(`${index}:${request.id}`);
      spawned[index]?.respond(request.id, reply);
    },
    emit(index: number, event: { type: string } & Record<string, unknown>): void {
      spawned[index]?.emit({ type: "pi_event", event });
    },
    dispose(): void {
      exports.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

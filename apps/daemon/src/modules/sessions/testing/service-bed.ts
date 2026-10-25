import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type Caller,
  type CommandInput,
  type Cursor,
  type EventFrame,
  type InitRecord,
  type WorkerRecord,
} from "@pap/contracts";
import type { ProjectBoxSource } from "../../../kernel/boxes.ts";
import { type Clock, createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { type Logger, silentLogger } from "../../../kernel/logger.ts";
import type { WorkerHandle } from "../../../kernel/supervisor/worker.ts";
import { createFakeWorker, type FakeWorker } from "../../../kernel/testing/fake-worker.ts";
import { createStreamHub, type StreamHub } from "../../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../../audit/index.ts";
import type { AttachmentsPort } from "../../files/index.ts";
import type { PolicyPort } from "../../policy/index.ts";
import type { ProjectsPort } from "../../projects/index.ts";
import { fakeVmLaunch } from "./fake-vm-launch.ts";
import { withVmPorts } from "./vm-ports.ts";
import {
  type Admission,
  createExports,
  type Exports,
  loadPiWriter,
  type PiWriter,
  SESSIONS_MIGRATIONS,
} from "../index.ts";
import { fakePolicyPort } from "./fake-policy.ts";
import { noAttachments } from "./no-attachments.ts";
import { fakeProjectsPort } from "./fake-projects.ts";
import { sessionFileText } from "./pi-file-writers.ts";
import type { SessionsModuleDeps, VmLaunch } from "../index.ts";
import { testCaller } from "../../../testing/caller.ts";
import { sharesAll } from "./providers.ts";

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
  readonly isMember?: (userId: string) => boolean;
  readonly providers?: SessionsModuleDeps["providers"];
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
  /** The owner's box projects (late-bound in the daemon); none by default. */
  boxes?: ProjectBoxSource;
  /** The instance owner adopted sessions go to; defaults to `u1`. */
  ownerId?(): string | null;
  /** Called once per adopted row (agreement 8). */
  onAdopted?(sessionId: string): void;
  /** Called when a write outside pap added tool results (M7R27); defaults to nothing. */
  onOutsideToolResults?(sessionId: string): void;
  /** The audit module's port; defaults to one that takes everything and keeps nothing. */
  audit?: AuditPort;
  /** The claims of pending uploads; defaults to a port that knows no upload. */
  attachments?: AttachmentsPort;
  /** What the daemon knows of the worker's containment; defaults to "none". */
  containment?: "scope" | "none";
  /** Replaces the writer of forks and clones (a test of how the service treats what it returns). */
  writer?: PiWriter;
  /** The transcript reader fails to load this many times before it loads. */
  readerFailures?: number;
  /** The idle release delay; 0 (the default) turns the release off. */
  idleMs?: number;
  /** A worker told to stop exits only when the test crashes it (`bed.spawned[i].crash(...)`). */
  holdShutdown?: boolean;
  /** The fork cap and the disk floor; none by default. */
  admission?: (clock: Clock) => Admission;
  /** Agents run in VMs (T8a): the launcher, given a maker of the bed's fake workers. */
  vmLaunch?(makeWorker: () => WorkerHandle, bed: { papHome: string }): VmLaunch;
  /** Replaces the session id source (`p1`, `p2`, ...). */
  newId?(): string;
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
export const OWNER: Caller = testCaller();

const IDLE_STATE = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  sessionFile: "/f",
  sessionId: "s",
};

/** What a sessions service is built from. The service and store themselves are the test's own: see `Factories`. */
export interface ServiceParts<Store, Reader> {
  isMember(userId: string): boolean;
  readonly providers: SessionsModuleDeps["providers"];
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly policy: PolicyPort;
  readonly projects: ProjectsPort;
  readonly audit: AuditPort;
  readonly attachments: AttachmentsPort;
  readonly containment: "scope" | "none";
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
  ownerId(): string | null;
  onAdopted?(sessionId: string): void;
  onOutsideToolResults(sessionId: string): void;
  freeMemMb(): number;
  spawn(cwd: string, env?: Readonly<Record<string, string>>): WorkerHandle;
  loadTranscript(): Promise<Reader>;
  loadWriter(): Promise<PiWriter>;
  readonly admission?: Admission;
}

// A helper in `testing/` may import a module only through its index (the boundaries rule), so the service and the
// store come in from the test files, which sit in the module and import what they test directly.
export interface ServiceLike {
  snapshot(key: string): unknown;
  prepareSubscription(sessionId: string, caller: Caller, after?: Cursor): Promise<Cursor | undefined>;
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
  /** The per-worker environment each spawn was given, by spawn order (undefined: none). */
  const spawnEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
  /** The session file each worker reported in `ready`, by spawn order. It exists only once the test writes it. */
  const files: string[] = [];
  let ids = 0;
  const transcript = { loads: 0, failures: options.readerFailures ?? 0 };
  const answered = new Set<string>();
  const exportsDir = join(dir, "pap", "exports");
  const forkTmpDir = join(dir, "pap", "fork-tmp");
  const exports = createExports({ dir: exportsDir, clock, logger: options.logger ?? silentLogger });
  const projects = options.projects ?? fakeProjectsPort();
  const makeWorker = (env?: Readonly<Record<string, string>>): FakeWorker => {
    const index = spawned.length;
    spawnEnvs.push(env);
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
        const sessionFile = behavior.sessionFile ?? record.sessionFile ?? join(sessionsDir, `${piId}.jsonl`);
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
  };
  const service = factories.createSessionsService({
    store,
    clock,
    logger: options.logger ?? silentLogger,
    hub,
    policy: options.policy ?? fakePolicyPort(),
    projects,
    ...(options.boxes ? { boxes: () => options.boxes } : {}),
    isMember: options.isMember ?? (() => false),
    providers: options.providers ?? sharesAll,
    audit: options.audit ?? { append: () => {}, reserve: () => true, fromWorker: () => null },
    attachments: options.attachments ?? noAttachments,
    containment: options.containment ?? "none",
    exports,
    limits: options.limits ?? { maxWorkers: 4, minFreeMemMb: 0 },
    idleMs: options.idleMs ?? 0,
    worker: {
      agentDir,
      papHome: join(dir, "pap"),
      umask: options.umask ?? 0o022,
      testProviderScript: options.testProviderScript ?? null,
    },
    newId: options.newId ?? (() => `p${++ids}`),
    ownerId: options.ownerId ?? (() => "u1"),
    ...(options.onAdopted ? { onAdopted: options.onAdopted } : {}),
    onOutsideToolResults: options.onOutsideToolResults ?? (() => {}),
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
    ...(options.admission ? { admission: options.admission(clock) } : {}),
    spawn: (_cwd, env) => makeWorker(env),
    ...{ vmLaunch: (options.vmLaunch ?? fakeVmLaunch)(() => makeWorker(), { papHome: join(dir, "pap") }) },
  });
  // Agents run in microVMs only: the bed's agent ports get the VM predicates unless the test names its own.
  const surface = (service as { agent?: { setAgentPorts(ports: Parameters<typeof withVmPorts>[1]): void } })
    .agent;
  if (surface) {
    const setAgentPorts = surface.setAgentPorts;
    surface.setAgentPorts = (ports) => setAgentPorts(withVmPorts(join(dir, "pap"), ports));
  }
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
    spawnEnvs,
    files,
    transcript,
    /** What a client is given: `subscribe.session` prepares the read first (owner, transcript reader), then the hub builds this. */
    async snapshot(sessionId: string): Promise<ReturnType<Service["snapshot"]>> {
      await service.prepareSubscription(sessionId, OWNER);
      return service.snapshot(sessionId) as ReturnType<Service["snapshot"]>;
    },
    /** A client subscribing through the same two steps; the frames it receives collect in the returned array. */
    async subscribe(sessionId: string, after?: Cursor): Promise<EventFrame[]> {
      const from = await service.prepareSubscription(sessionId, OWNER, after);
      const frames: EventFrame[] = [];
      hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "session",
        key: sessionId,
        after: from,
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

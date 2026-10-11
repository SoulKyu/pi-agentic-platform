import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ALL_PERMISSIONS,
  type Caller,
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
import { SESSIONS_MIGRATIONS } from "../index.ts";

/** What a fake worker does when it gets `init`. */
export type StartBehavior =
  | {
      kind: "ready";
      piId?: string;
      sessionFile?: string;
      /** Said just before `ready`. */ before?: WorkerRecord[];
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
  /** The transcript reader fails to load this many times before it loads. */
  readerFailures?: number;
  /** By the order the workers are spawned in, from 0. */
  start?(index: number, init: InitRecord): StartBehavior | undefined;
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A Pi session file (format 3) holding these exchanges, as `[user text, assistant text]`. */
export function sessionFileText(piId: string, exchanges: ReadonlyArray<readonly [string, string]>): string {
  const rows: unknown[] = [
    { type: "session", version: 3, id: piId, timestamp: "2026-10-10T00:00:00.000Z", cwd: "/w" },
  ];
  // Pi puts its system prompt in the file as the first message (S1); the daemon never shows it (R107).
  rows.push({
    type: "message",
    id: "s0",
    parentId: null,
    timestamp: "2026-10-10T00:00:00.500Z",
    message: {
      role: "system",
      content: "",
      sections: { preamble: "You are an expert coding assistant" },
      timestamp: 0,
    },
  });
  let parentId: string | null = "s0";
  exchanges.forEach(([user, assistant], index) => {
    const userId = `u${index}`;
    const assistantId = `a${index}`;
    rows.push(
      {
        type: "message",
        id: userId,
        parentId,
        timestamp: "2026-10-10T00:00:01.000Z",
        message: { role: "user", content: user, timestamp: 1 },
      },
      {
        type: "message",
        id: assistantId,
        parentId: userId,
        timestamp: "2026-10-10T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistant }],
          api: "x",
          provider: "x",
          model: "x",
          usage,
          stopReason: "stop",
          timestamp: 2,
        },
      },
    );
    parentId = assistantId;
  });
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
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
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
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
  const agentDir = join(dir, "agent");
  const sessionsDir = join(agentDir, "sessions", "--w--");
  mkdirSync(work);
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
  const service = factories.createSessionsService({
    store,
    clock,
    logger: options.logger ?? silentLogger,
    hub,
    limits: options.limits ?? { maxWorkers: 4, minFreeMemMb: 0 },
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
    freeMemMb: () => options.freeMemMb ?? 4096,
    spawn: () => {
      const index = spawned.length;
      const worker = createFakeWorker({
        clock,
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
            self.emit({ type: "ready", sessionId: piId, sessionFile, piVersion: "1.1.0" });
          });
        },
        reply: (command) => {
          if (command.type === "prompt") return { data: { disposition: "started" } };
          if (command.type === "get_state") return { data: IDLE_STATE };
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
    agentDir,
    clock,
    db,
    store,
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
    emit(index: number, event: { type: string } & Record<string, unknown>): void {
      spawned[index]?.emit({ type: "pi_event", event });
    },
    dispose(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

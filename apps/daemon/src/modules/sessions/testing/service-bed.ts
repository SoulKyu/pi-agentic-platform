import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { InitRecord } from "@pap/contracts";
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
  { kind: "ready"; piId?: string; sessionFile?: string } | { kind: "silent" } | { kind: "exit70" };

export interface BedOptions {
  limits?: { maxWorkers: number; minFreeMemMb: number };
  freeMemMb?: number;
  testProviderScript?: string | null;
  logger?: Logger;
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
  let parentId: string | null = null;
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

const IDLE_STATE = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
  sessionFile: "/f",
  sessionId: "s",
};

/** What a sessions service is built from. The service and store themselves are the test's own: see `Factories`. */
export interface ServiceParts<Store> {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
  readonly worker: {
    readonly agentDir: string;
    readonly papHome: string;
    readonly testProviderScript: string | null;
  };
  newId(): string;
  freeMemMb(): number;
  spawn(cwd: string): WorkerHandle;
}

// A helper in `testing/` may import a module only through its index (the boundaries rule), so the service and the
// store come in from the test files, which sit in the module and import what they test directly.
export interface Factories<Store, Service extends { snapshot(key: string): unknown }> {
  createSessionsStore(db: Db): Store;
  createSessionsService(parts: ServiceParts<Store>): Service;
}

/** A sessions service over a real database, a real stream hub and fake workers, in a temporary directory. */
export function createServiceBed<Store, Service extends { snapshot(key: string): unknown }>(
  factories: Factories<Store, Service>,
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
  const service = factories.createSessionsService({
    store,
    clock,
    logger: options.logger ?? silentLogger,
    hub,
    limits: options.limits ?? { maxWorkers: 4, minFreeMemMb: 0 },
    worker: { agentDir, papHome: join(dir, "pap"), testProviderScript: options.testProviderScript ?? null },
    newId: () => `p${++ids}`,
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
          queueMicrotask(() =>
            self.emit({ type: "ready", sessionId: piId, sessionFile, piVersion: "1.1.0" }),
          );
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

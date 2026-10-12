import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_PERMISSIONS,
  type Cursor,
  type EventFrame,
  type HandlerContext,
  type SessionStreamEvent,
} from "@pap/contracts";
import { vi } from "vitest";
import { workerExecArgv } from "../../../kernel/config.ts";
import { createSystemClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import type { WorkerExit } from "../../../kernel/supervisor/exit.ts";
import { NO_SCOPES, type WorkerScopes } from "../../../kernel/supervisor/scope.ts";
import { newId } from "../../../kernel/ids.ts";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { createPolicyModule, POLICY_MIGRATIONS } from "../../policy/index.ts";
import { createProjectsModule, PROJECTS_MIGRATIONS } from "../../projects/index.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS, type SessionsModule } from "../index.ts";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));
const EXEC_ARGV = [
  ...workerExecArgv(["--conditions=development"]),
  "--disable-warning=ExperimentalWarning",
  "--import",
  join(REPO, "packages/pi-host/src/testing/network-guard.ts"),
];
const WAIT_MS = 20_000;

export interface IntBedOptions {
  /** `<name>.js` sources written into `<agentDir>/extensions/` (Pi loads them without project trust). */
  readonly extensions?: Readonly<Record<string, string>>;
  /** Written to `<agentDir>/settings.json`. */
  readonly settings?: object;
  readonly maxWorkers?: number;
  /** The idle release delay in milliseconds (default 30 minutes, the daemon's own). */
  readonly workerIdleMs?: number;
  /** Real scopes for the tests that need them (Task 22); every other test runs workers unscoped (owner R2-3). */
  readonly scopes?: WorkerScopes;
  /** How the daemon is told where the agent folder is (default: as is); `agentDir` stays the plain path. */
  readonly spellAgentDir?: (agentDir: string) => string;
}

export interface Subscription {
  events(): SessionStreamEvent[];
  /** The cursor of the last event received, as a client keeps it for a reopen. */
  cursor(): Cursor | undefined;
  close(): void;
  waitFor(predicate: (event: SessionStreamEvent) => boolean, timeoutMs?: number): Promise<SessionStreamEvent>;
}

/** The sessions module with the real pi-host on a scripted model, every path under a temporary root (R94). */
export async function createIntBed(script: object, options: IntBedOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "pap-int-sessions-"));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  const papHome = join(root, "pap");
  // Whatever fails during setup must not leave the temporary root behind.
  try {
    for (const dir of [agentDir, work, papHome, join(root, "home"), join(agentDir, "extensions")]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const [name, source] of Object.entries(options.extensions ?? {})) {
      writeFileSync(join(agentDir, "extensions", `${name}.js`), source);
    }
    if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
    writeFileSync(join(root, "script.json"), JSON.stringify(script));
    const clock = createSystemClock();
    const db = migrate({
      dbPath: join(root, "state.db"),
      backupsDir: join(root, "backups"),
      sources: [KERNEL_MIGRATIONS, POLICY_MIGRATIONS, SESSIONS_MIGRATIONS, PROJECTS_MIGRATIONS],
      clock,
      logger: silentLogger,
    }).db;
    const hub = createStreamHub(undefined, clock);
    const exits: Array<{ sessionId: string; exit: WorkerExit; outputTail: string }> = [];
    const policy = createPolicyModule({ db, clock, logger: silentLogger, newId });
    const projects = createProjectsModule({ db, clock, logger: silentLogger, newId });
    const sessions: SessionsModule = createSessionsModule({
      db,
      clock,
      logger: silentLogger,
      hub,
      policy: policy.port,
      projects: projects.port,
      ownerId: () => "u1",
      config: {
        home: papHome,
        piAgentDir: options.spellAgentDir?.(agentDir) ?? agentDir,
        piHostEntry: join(REPO, "packages/pi-host/src/main.ts"),
        piHostExecArgv: EXEC_ARGV,
        testProviderScript: join(root, "script.json"),
        maxWorkers: options.maxWorkers ?? 4,
        minFreeMemMb: 0,
        workerIdleMs: options.workerIdleMs ?? 30 * 60_000,
      },
      workerUmask: 0o022,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
      scopes: options.scopes ?? NO_SCOPES,
      onWorkerExit: (sessionId, info) => void exits.push({ sessionId, ...info }),
    });
    let connections = 0;
    const contextOf = (connectionId: string, sink: EventFrame[]): HandlerContext => ({
      caller: { userId: "u1", permissions: new Set(ALL_PERMISSIONS) },
      connectionId,
      openSubscription: (stream, key, after) => {
        const sub = `s-${connectionId}`;
        hub.open({ connectionId, sub, stream, key, after, send: (frame) => void sink.push(frame) });
        return sub;
      },
      closeSubscription: (sub) => hub.close(connectionId, sub),
    });
    const owner = contextOf("bed", []);
    return {
      root,
      agentDir,
      work,
      papHome,
      sessions,
      exits,
      rpc: sessions.rpc,
      policyRpc: policy.rpc,
      ctx: owner,
      async subscribe(sessionId: string, after?: Cursor): Promise<Subscription> {
        const frames: EventFrame[] = [];
        const context = contextOf(`c${++connections}`, frames);
        const { sub } = await sessions.rpc["subscribe.session"](
          after ? { sessionId, after } : { sessionId },
          context,
        );
        const events = () => frames.map((frame) => frame.event as SessionStreamEvent);
        return {
          events,
          cursor: () => {
            const last = frames.at(-1);
            return last ? { epoch: last.epoch, seq: last.seq } : undefined;
          },
          close: () => context.closeSubscription(sub),
          async waitFor(predicate, timeoutMs = WAIT_MS) {
            let found: SessionStreamEvent | undefined;
            await vi.waitFor(
              () => {
                found = events().find(predicate);
                if (!found) throw new Error("not yet");
              },
              { timeout: timeoutMs },
            );
            return found as SessionStreamEvent;
          },
        };
      },
      /** SIGKILLs a session's worker; a pid of 0 or 1 would signal our own group or every process, so it is refused. */
      killWorker(sessionId: string): number {
        const pid = sessions.inspect(sessionId)?.pid;
        if (pid === undefined || !Number.isInteger(pid) || pid <= 1)
          throw new Error(`no worker pid for ${sessionId}`);
        process.kill(pid, "SIGKILL");
        return pid;
      },
      async dispose(): Promise<void> {
        try {
          await sessions.shutdownAll();
        } finally {
          db.close();
          rmSync(root, { recursive: true, force: true });
        }
        const blocked = exits
          .flatMap((exit) => exit.outputTail.split("\n"))
          .filter((line) => line.startsWith("pap-network-guard: blocked"));
        if (blocked.length > 0)
          throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
export type IntBed = Awaited<ReturnType<typeof createIntBed>>;

/** Prompts and waits for the run to settle (status `running`, then `idle`). */
export async function promptAndSettle(
  bed: IntBed,
  sub: Subscription,
  sessionId: string,
  text: string,
): Promise<void> {
  const before = sub.events().length;
  await bed.rpc["sessions.prompt"]({ sessionId, text }, bed.ctx);
  await vi.waitFor(
    () => {
      const statuses = sub
        .events()
        .slice(before)
        .flatMap((event) => (event.kind === "status" ? [event.status] : []));
      // A worker reopened for this prompt says `starting` and `idle` before the run: only an `idle` after `running` settles.
      if (!statuses.includes("running") || statuses.lastIndexOf("idle") <= statuses.indexOf("running"))
        throw new Error("still running");
    },
    { timeout: WAIT_MS },
  );
}

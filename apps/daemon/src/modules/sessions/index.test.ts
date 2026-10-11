import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PERMISSIONS, type Caller, type HandlerContext } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { type SpawnWorkerOptions } from "../../kernel/supervisor/worker.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { createStreamHub } from "../../kernel/ws/stream-hub.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS } from "./index.ts";
import { captureLogger } from "./testing/helpers.ts";

// The real supervisor forks a process; here it only records what it was asked to start, and answers like a worker.
const spawned = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("../../kernel/supervisor/worker.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../kernel/supervisor/worker.ts")>()),
  spawnWorker: (options: SpawnWorkerOptions) => {
    spawned.options.push(options);
    return createFakeWorker({
      onSend: (record, self) => {
        if (record.type === "init") {
          queueMicrotask(() =>
            self.emit({ type: "ready", sessionId: "pi-1", sessionFile: "/x/pi-1.jsonl", piVersion: "1" }),
          );
        }
      },
    });
  },
}));

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const ctx: HandlerContext = {
  caller: owner,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
};

let root: string;
let db: Db;
beforeEach(() => {
  spawned.options.length = 0;
  root = mkdtempSync(join(tmpdir(), "pap-sessions-index-"));
  db = migrate({
    dbPath: join(root, "s.db"),
    backupsDir: join(root, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const config = (testProviderScript: string | null) => ({
  home: join(root, "pap"),
  piAgentDir: join(root, "agent"),
  piHostEntry: "/pi-host/main.ts",
  piHostExecArgv: ["--conditions=development"],
  testProviderScript,
  maxWorkers: 2,
  minFreeMemMb: 0,
});
const daemonEnv = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  NODE_OPTIONS: "--require /evil.js",
  PAP_SECRET_KEY: "do-not-pass",
  PAP_HOME: "/elsewhere",
  PI_TELEMETRY: "1",
};

function moduleWith(testProviderScript: string | null, logger = silentLogger) {
  const hub = createStreamHub();
  const sessions = createSessionsModule({
    db,
    clock: createFakeClock(),
    logger,
    hub,
    config: config(testProviderScript),
    env: daemonEnv,
  });
  return { sessions, hub };
}
const started = () => spawned.options[0] as SpawnWorkerOptions;

describe("sessions module", () => {
  it("starts the worker the way the supervisor and the worker expect (R93, R96)", async () => {
    const { sessions } = moduleWith(null);
    await sessions.rpc["sessions.create"]({ cwd: root }, ctx);
    expect(started()).toMatchObject({
      entry: "/pi-host/main.ts",
      execArgv: ["--conditions=development"],
      cwd: expect.stringContaining("pap-sessions-index-"),
    });
    expect(started().env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });

  it("marks the worker as a test provider host only when a script is configured, and says so in the log", async () => {
    const { logger, lines } = captureLogger();
    const { sessions } = moduleWith("/scripts/provider.json", logger);
    expect(lines.find((line) => line.msg === "test_provider_enabled")).toMatchObject({ level: "warn" });
    await sessions.rpc["sessions.create"]({ cwd: root }, ctx);
    expect(started().env.PAP_TEST_PROVIDER).toBe("1");
    expect(started().env).not.toHaveProperty("PAP_SECRET_KEY");
    const plain = captureLogger();
    moduleWith(null, plain.logger);
    expect(plain.lines.some((line) => line.msg === "test_provider_enabled")).toBe(false);
  });

  it("answers the session stream only for sessions it knows (R79)", () => {
    const { hub } = moduleWith(null);
    const open = () =>
      hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "session",
        key: "nope",
        after: undefined,
        send: () => {},
      });
    expect(open).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(hub.stats().channels).toBe(0);
  });

  it("reports a running worker's process and memory, and nothing for an unknown session", async () => {
    const { sessions } = moduleWith(null);
    const { sessionId } = await sessions.rpc["sessions.create"]({ cwd: root }, ctx);
    expect(sessions.inspect(sessionId)).toEqual({ pid: 4242, rssMb: null });
    expect(sessions.inspect("nope")).toBeNull();
    await sessions.shutdownAll();
  });
});

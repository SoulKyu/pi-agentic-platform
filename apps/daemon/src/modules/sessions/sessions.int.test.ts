import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { ALL_PERMISSIONS, type Caller, type EventFrame, type HandlerContext } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createStreamHub, type StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS, type SessionsModule } from "./index.ts";
import { createSessionsStore, type SessionsStore } from "./store.ts";

// The real pi-host in a real forked process, on a scripted model, with the network closed (never a real provider).
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
let root: string;
let db: Db;
let hub: StreamHub;
let store: SessionsStore;
let sessions: SessionsModule;
let frames: EventFrame[];
let agentDir: string;
let work: string;

function moduleWith(testProviderScript: string): SessionsModule {
  return createSessionsModule({
    db,
    clock: createSystemClock(),
    logger: silentLogger,
    hub,
    config: {
      home: join(root, "pap"),
      piAgentDir: agentDir,
      piHostEntry: ENTRY,
      piHostExecArgv: EXEC_ARGV,
      testProviderScript,
      maxWorkers: 2,
      minFreeMemMb: 0,
    },
    workerUmask: 0o022,
    env: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-sessions-int-"));
  agentDir = join(root, "agent");
  work = join(root, "work");
  for (const dir of [agentDir, work, join(root, "pap"), join(root, "home")]) mkdirSync(dir);
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "a scripted answer" }] }));
  const clock = createSystemClock();
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  store = createSessionsStore(db);
  hub = createStreamHub();
  frames = [];
  sessions = moduleWith(join(root, "script.json"));
});
afterEach(async () => {
  await sessions.shutdownAll();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const ctx: HandlerContext = {
  caller: owner,
  connectionId: "c1",
  openSubscription: (stream, key, after) => {
    hub.open({ connectionId: "c1", sub: "s1", stream, key, after, send: (frame) => frames.push(frame) });
    return "s1";
  },
  closeSubscription: () => {},
};
const events = () =>
  frames.map((frame) => frame.event as { kind: string; status?: string; rows?: unknown[] });
const statuses = () => events().flatMap((event) => (event.kind === "status" ? [event.status] : []));
const listed = (id: string) =>
  sessions.rpc["sessions.list"]({}, ctx).then(({ sessions: all }) => all.find((s) => s.id === id));

// The rows a client starting from the snapshot would have.
async function snapshotRows(id: string): Promise<string[]> {
  const seen: EventFrame[] = [];
  await sessions.rpc["subscribe.session"](
    { sessionId: id },
    {
      ...ctx,
      connectionId: "probe",
      openSubscription: (stream, key, after) => {
        hub.open({ connectionId: "probe", sub: "p", stream, key, after, send: (f) => seen.push(f) });
        return "p";
      },
    },
  );
  hub.close("probe");
  const rows = (seen[0]?.event as { rows: Array<{ message: { role: string } }> }).rows;
  return rows.map((row) => row.message.role);
}

async function promptAndSettle(id: string, text: string): Promise<void> {
  const before = statuses().length;
  expect(await sessions.rpc["sessions.prompt"]({ sessionId: id, text }, ctx)).toEqual({
    disposition: "started",
  });
  // A worker started for the prompt says "idle" first; the run is the "running" and the "idle" after it.
  await vi.waitFor(() => expect(statuses().slice(before).slice(-2)).toEqual(["running", "idle"]), {
    timeout: 20_000,
  });
}

describe("sessions with the real pi-host", () => {
  it("creates, prompts, streams, survives a killed worker and picks up where Pi's file left off", async () => {
    const { sessionId } = await sessions.rpc["sessions.create"]({ cwd: work }, ctx);
    await sessions.rpc["subscribe.session"]({ sessionId }, ctx);
    expect(events()[0]).toMatchObject({ kind: "snapshot", status: "idle", rows: [] });
    // Pi has not written a file for a session nobody has spoken to.
    expect(store.get(sessionId)).toMatchObject({ piPath: null, piSessionId: null, cwd: realpathSync(work) });

    await promptAndSettle(sessionId, "hello");
    const bound = store.get(sessionId);
    expect(bound?.piPath).toContain(join(agentDir, "sessions"));
    expect(bound?.piPath && existsSync(bound.piPath)).toBe(true);
    expect(events().some((event) => event.kind === "pi")).toBe(true);
    expect(await snapshotRows(sessionId)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(frames)).toContain("a scripted answer");
    // Pi's system prompt is in its file and in its events; none of it reaches a subscriber (R107).
    expect(JSON.stringify(frames)).not.toContain('"role":"system"');
    expect(JSON.stringify(frames)).not.toContain("expert coding assistant");

    const pid = sessions.inspect(sessionId)?.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    process.kill(pid, "SIGKILL");
    await vi.waitFor(async () => expect((await listed(sessionId))?.status).toBe("cold"), { timeout: 10_000 });
    expect(events().at(-1)).toMatchObject({ kind: "status", status: "cold" });

    await promptAndSettle(sessionId, "again");
    expect(store.get(sessionId)).toEqual(bound ? { ...bound, updatedAt: expect.any(Number) } : undefined);
    expect(await snapshotRows(sessionId)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("reopens a session nobody has spoken to as a new Pi session under the same id (R10, R37)", async () => {
    const { sessionId } = await sessions.rpc["sessions.create"]({ cwd: work }, ctx);
    process.kill(sessions.inspect(sessionId)?.pid ?? 0, "SIGKILL");
    await vi.waitFor(async () => expect((await listed(sessionId))?.status).toBe("cold"), { timeout: 10_000 });
    await sessions.rpc["subscribe.session"]({ sessionId }, ctx);
    await promptAndSettle(sessionId, "hello");
    expect(store.get(sessionId)?.piPath).toContain(join(agentDir, "sessions"));
    expect(await snapshotRows(sessionId)).toEqual(["user", "assistant"]);
    expect((await sessions.rpc["sessions.list"]({}, ctx)).sessions).toHaveLength(1);
  });

  it("keeps a project's own extensions from loading until the project is trusted, in Pi's own trust store (R48)", async () => {
    const ran = join(root, "ran.txt");
    mkdirSync(join(work, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(work, ".pi", "extensions", "probe.js"),
      `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(ran)}, "ran\\n"); }\n`,
    );
    await sessions.rpc["sessions.create"]({ cwd: work }, ctx);
    expect(existsSync(ran)).toBe(false);
    new ProjectTrustStore(agentDir).set(realpathSync(work), true);
    await sessions.rpc["sessions.create"]({ cwd: work }, ctx);
    expect(existsSync(ran)).toBe(true);
  });

  it("answers worker_failed in fixed words when the worker cannot start, and keeps nothing", async () => {
    const broken = moduleWith(join(root, "missing-script.json"));
    const outcome = await broken.rpc["sessions.create"]({ cwd: work }, ctx).then(
      () => null,
      (error: Error & { code: string }) => ({ code: error.code, message: error.message }),
    );
    expect(outcome).toEqual({ code: "worker_failed", message: "The session process failed." });
    expect((await broken.rpc["sessions.list"]({}, ctx)).sessions).toEqual([]);
    await broken.shutdownAll();
  });
});

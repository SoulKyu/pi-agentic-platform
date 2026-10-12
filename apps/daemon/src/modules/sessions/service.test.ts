import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PERMISSIONS, type Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { READY_TIMEOUT_MS } from "./live-session.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const stranger: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };
const confirm = {
  type: "extension_ui_request" as const,
  id: "d1",
  method: "confirm",
  title: "Run?",
  message: "bash: ls",
};

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

describe("create", () => {
  it("makes a session in a real folder under its own id, as a draft, and lists it as idle", async () => {
    open();
    expect(await bed.service.create(bed.work, owner)).toEqual({ sessionId: "p1" });
    expect(bed.service.list(owner)).toEqual([
      expect.objectContaining({ id: "p1", cwd: realpathSync(bed.work), status: "idle" }),
    ]);
    // Pi has not written a file yet, and its id for the session is not the session's id.
    expect(bed.store.get("p1")).toMatchObject({ piPath: null, piSessionId: null });
    expect(bed.spawned[0]?.sent[0]).toEqual({
      type: "init",
      cwd: realpathSync(bed.work),
      agentDir: bed.agentDir,
      papHome: join(bed.dir, "pap"),
      umask: 0o022,
      policy: { profile: "interactive", approvalMode: "auto-accept-edits", alwaysAllow: [] },
    });
  });

  it("hands the worker the umask the daemon was started with, not its own (R114)", async () => {
    open({ umask: 0o027 });
    await bed.service.create(bed.work, owner);
    expect(bed.spawned[0]?.sent[0]).toMatchObject({ type: "init", umask: 0o027 });
  });

  it("hands the worker a test provider script only when one is configured", async () => {
    open({ testProviderScript: "/scripts/provider.json" });
    await bed.service.create(bed.work, owner);
    expect(bed.spawned[0]?.sent[0]).toMatchObject({ testProviderScript: "/scripts/provider.json" });
  });

  it("refuses a bad working directory before spawning anything", async () => {
    open();
    expect(await codeOf(bed.service.create("relative/path", owner))).toBe("invalid_cwd");
    expect(bed.spawned).toHaveLength(0);
  });

  it("refuses new workers above the cap or under the free-memory floor", async () => {
    open({ limits: { maxWorkers: 1, minFreeMemMb: 0 } });
    await bed.service.create(bed.work, owner);
    expect(await codeOf(bed.service.create(bed.work, owner))).toBe("capacity");
    bed.dispose();
    open({ limits: { maxWorkers: 4, minFreeMemMb: 512 }, freeMemMb: 100 });
    expect(await codeOf(bed.service.create(bed.work, owner))).toBe("capacity");
    expect(bed.spawned).toHaveLength(0);
  });

  it("counts workers that are still starting against the cap (R9)", async () => {
    open({ limits: { maxWorkers: 1, minFreeMemMb: 0 } });
    const outcomes = await Promise.all([
      codeOf(bed.service.create(bed.work, owner)),
      codeOf(bed.service.create(bed.work, owner)),
    ]);
    expect(outcomes).toEqual([null, "capacity"]);
    expect(bed.spawned).toHaveLength(1);
  });

  it("leaves no trace of a worker that failed to start, and frees its place (R93)", async () => {
    open({
      limits: { maxWorkers: 1, minFreeMemMb: 0 },
      start: (index) => (index === 0 ? { kind: "exit70" } : undefined),
    });
    expect(await codeOf(bed.service.create(bed.work, owner))).toBe("worker_failed");
    expect(bed.service.list(owner)).toEqual([]);
    expect(bed.db.get("SELECT COUNT(*) AS n FROM session_events")).toEqual({ n: 0 });
    expect(bed.hub.stats().channels).toBe(0);
    expect(await bed.service.create(bed.work, owner)).toEqual({ sessionId: "p2" });
  });

  it("gives up on a worker that never says it is ready, stops it, and frees its place", async () => {
    open({
      limits: { maxWorkers: 1, minFreeMemMb: 0 },
      start: (index) => (index === 0 ? { kind: "silent" } : undefined),
    });
    const outcome = codeOf(bed.service.create(bed.work, owner));
    await bed.clock.advance(READY_TIMEOUT_MS);
    expect(await outcome).toBe("worker_failed");
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(await bed.service.create(bed.work, owner)).toEqual({ sessionId: "p2" });
  });
});

describe("the Pi file of a draft", () => {
  it("is remembered, with Pi's id for the session, once Pi has written it", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_end", message: { role: "user", content: "hi" } });
    expect(bed.store.get("p1")?.piPath).toBeNull();
    const file = bed.writePiFile(0);
    bed.emit(0, { type: "message_start", message: { role: "assistant" } });
    expect(bed.store.get("p1")).toMatchObject({ piPath: file, piSessionId: "pi-0" });
  });

  it("is remembered when the run ends, if no event came after Pi wrote it", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    const file = bed.writePiFile(0);
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(bed.store.get("p1")?.piPath).toBe(file);
  });

  it("is remembered when the worker dies right after writing it", async () => {
    open();
    await bed.service.create(bed.work, owner);
    const file = bed.writePiFile(0);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(bed.store.get("p1")?.piPath).toBe(file);
  });

  it("is refused when it is not where Pi keeps its sessions", async () => {
    const { logger, lines } = captureLogger();
    open({ logger, start: () => ({ kind: "ready", sessionFile: join(bed.dir, "elsewhere.jsonl") }) });
    writeFileSync(join(bed.dir, "elsewhere.jsonl"), "{}\n");
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    expect(bed.store.get("p1")?.piPath).toBeNull();
    expect(lines.filter((line) => line.msg === "session_file_refused")).toHaveLength(1);
    // And only said once: the session is not asked again.
    bed.emit(0, { type: "turn_start" });
    expect(lines.filter((line) => line.msg === "session_file_refused")).toHaveLength(1);
  });
});

describe("a session whose worker is gone", () => {
  it("restarts once, on its own file, even when prompts come together", async () => {
    open();
    await bed.service.create(bed.work, owner);
    const file = bed.writePiFile(0);
    bed.emit(0, { type: "turn_start" });
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(bed.service.list(owner)[0]?.status).toBe("cold");
    await Promise.all([
      bed.service.prompt({ sessionId: "p1", text: "one" }, owner),
      bed.service.prompt({ sessionId: "p1", text: "two" }, owner),
    ]);
    expect(bed.spawned).toHaveLength(2);
    expect(bed.spawned[1]?.sent[0]).toMatchObject({ type: "init", sessionFile: file });
    expect(bed.service.list(owner)).toEqual([expect.objectContaining({ id: "p1", status: "idle" })]);
  });

  it("starts a new Pi session for a draft that never got a file, under the same id, without failing (R37)", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    await bed.service.prompt({ sessionId: "p1", text: "one" }, owner);
    expect(bed.spawned).toHaveLength(2);
    expect(bed.spawned[1]?.sent[0]).not.toHaveProperty("sessionFile");
    expect(bed.service.list(owner)).toEqual([expect.objectContaining({ id: "p1", status: "idle" })]);
    // The new Pi session is the one the draft binds to once Pi writes it.
    const file = bed.writePiFile(1);
    bed.emit(1, { type: "turn_start" });
    expect(bed.store.get("p1")).toMatchObject({ piPath: file, piSessionId: "pi-1" });
    expect(bed.service.list(owner)).toHaveLength(1);
  });

  it("shows as starting while its worker comes back, and as cold again if that fails", async () => {
    open({ start: (index) => (index === 1 ? { kind: "silent" } : undefined) });
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    const prompt = codeOf(bed.service.prompt({ sessionId: "p1", text: "hi" }, owner));
    expect(bed.service.list(owner)[0]?.status).toBe("starting");
    await bed.clock.advance(READY_TIMEOUT_MS);
    expect(await prompt).toBe("worker_failed");
    expect(bed.service.list(owner)[0]?.status).toBe("cold");
  });

  it("publishes starting when it reopens a cold session (R112)", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    const frames = await bed.subscribe(sessionId);
    void bed.service.prompt({ sessionId, text: "again" }, owner);
    await bed.clock.advance(0);
    const statuses = frames
      .map((frame) => frame.event as { kind: string; status?: string })
      .filter((event) => event.kind === "status")
      .map((event) => event.status);
    expect(statuses).toEqual(["starting", "idle"]);
  });

  it("is not restarted by itself: only a prompt brings it back", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(60_000);
    expect(bed.spawned).toHaveLength(1);
  });

  it("fails a restart whose file now belongs to another Pi session, and stops that worker", async () => {
    open({ start: (index) => (index === 1 ? { kind: "ready", piId: "someone-else" } : undefined) });
    await bed.service.create(bed.work, owner);
    bed.writePiFile(0);
    bed.emit(0, { type: "turn_start" });
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(await codeOf(bed.service.prompt({ sessionId: "p1", text: "hi" }, owner))).toBe("worker_failed");
    expect(bed.spawned[1]?.stopped()).toBe(true);
    expect(bed.service.list(owner)[0]?.status).toBe("cold");
  });

  it("refuses to restart when the cap is reached, and says capacity", async () => {
    open({ limits: { maxWorkers: 1, minFreeMemMb: 0 } });
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    await bed.service.create(bed.work, owner);
    expect(await codeOf(bed.service.prompt({ sessionId: "p1", text: "hi" }, owner))).toBe("capacity");
  });
});

describe("who may do what", () => {
  it("hides other users' sessions", async () => {
    open();
    await bed.service.create(bed.work, owner);
    expect(bed.service.list(stranger)).toEqual([]);
    const refused = [
      codeOf(bed.service.prompt({ sessionId: "p1", text: "hi" }, stranger)),
      codeOf(bed.service.abort("p1", stranger)),
      codeOf(bed.service.prepareSubscription("p1", stranger)),
      codeOf(
        Promise.resolve().then(() =>
          bed.service.respondDialog(
            { sessionId: "p1", dialogId: "d1", response: { confirmed: true } },
            stranger,
          ),
        ),
      ),
    ];
    expect(await Promise.all(refused)).toEqual(["not_found", "not_found", "not_found", "not_found"]);
    expect(bed.spawned).toHaveLength(1);
  });
});

describe("dialogs", () => {
  it("are answered once; the second answer gets not_found", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit(confirm);
    bed.service.respondDialog({ sessionId: "p1", dialogId: "d1", response: { confirmed: true } }, owner);
    expect(bed.spawned[0]?.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
    expect(() =>
      bed.service.respondDialog({ sessionId: "p1", dialogId: "d1", response: { confirmed: true } }, owner),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("cannot be answered for a session without a worker", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit(confirm);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(() =>
      bed.service.respondDialog({ sessionId: "p1", dialogId: "d1", response: { confirmed: true } }, owner),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("shutdown", () => {
  it("stops every worker, those still starting included, and takes no new ones", async () => {
    open({ start: (index) => (index === 1 ? { kind: "silent" } : undefined) });
    await bed.service.create(bed.work, owner);
    const starting = codeOf(bed.service.create(bed.work, owner));
    await bed.service.shutdownAll();
    expect(bed.spawned.map((worker) => worker.stopped())).toEqual([true, true]);
    expect(await starting).toBe("worker_failed");
    expect(await codeOf(bed.service.create(bed.work, owner))).toBe("capacity");
    expect(bed.spawned).toHaveLength(2);
  });
});

describe("abort and prompt", () => {
  it("record when the session was last used", async () => {
    open();
    await bed.service.create(bed.work, owner);
    const created = bed.service.list(owner)[0]?.updatedAt ?? 0;
    await bed.clock.advance(5000);
    expect(await bed.service.prompt({ sessionId: "p1", text: "hi" }, owner)).toEqual({
      disposition: "started",
    });
    expect(bed.service.list(owner)[0]?.updatedAt).toBe(created + 5000);
  });

  it("abort of a session without a worker does nothing", async () => {
    open();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    await expect(bed.service.abort("p1", owner)).resolves.toBeUndefined();
    expect(bed.spawned).toHaveLength(1);
  });

  it("report inspectable workers", async () => {
    open();
    await bed.service.create(bed.work, owner);
    expect(bed.service.inspect("p1")).toEqual({ pid: 4242, rssMb: null });
    bed.spawned[0]?.emit({ type: "health", rssMb: 150, descendants: 0 });
    expect(bed.service.inspect("p1")?.rssMb).toBe(150);
    expect(bed.service.inspect("nope")).toBeNull();
  });
});

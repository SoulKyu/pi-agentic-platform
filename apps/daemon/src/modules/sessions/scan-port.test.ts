import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EventFrame, type Marks, type ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createScanPort, type PiFileHeader } from "./scan-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore, type SessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const OWNER = testCaller();
const NO_MARKS: Marks = {
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: null,
};
const NOW = 1_800_000_000_000;

const fileOf = (name: string) => {
  const path = join(bed.sessionsDir, `${name}.jsonl`);
  writeFileSync(path, "");
  return path;
};
const headerOf = (id: string, createdAt = NOW - 10_000): PiFileHeader => ({ id, cwd: bed.work, createdAt });
const rowCount = () => bed.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n ?? 0;

/** Every adoption the hook was told of, and whether the row was already stored at that moment. */
function adoptions() {
  const calls: Array<{ id: string; stored: boolean }> = [];
  return { calls, hook: (id: string) => calls.push({ id, stored: bed.store.get(id) !== undefined }) };
}

function watchShell() {
  bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
  const frames: EventFrame[] = [];
  bed.hub.open({
    connectionId: "c-shell",
    sub: "s-shell",
    stream: "shell",
    key: "u1",
    after: undefined,
    send: (frame) => void frames.push(frame),
  });
  frames.length = 0;
  return () => frames.splice(0).map((frame) => frame.event as ShellStreamEvent);
}
const drain = () => bed.clock.advance(0);

/** A second port over the bed's database, as a restarted daemon builds it. */
const portOver = (overrides: Partial<Parameters<typeof createScanPort>[0]> = {}) =>
  createScanPort({
    store: bed.store,
    agentDir: bed.agentDir,
    clock: bed.clock,
    logger: silentLogger,
    newId: () => "new",
    ownerId: () => "u-other",
    livePiSession: () => null,
    assignProject: () => null,
    publisher: { changed: vi.fn(), projectChanged: vi.fn(), countsChanged: vi.fn() },
    activity: () => {},
    summary: () => null,
    onAdopted: () => {},
    ...overrides,
  });

describe("adopting a Pi file", () => {
  it("adopts a new file once, for the instance owner, and tells onAdopted after the insert", async () => {
    const spy = adoptions();
    bed = build({ onAdopted: spy.hook });
    await bed.clock.advance(NOW - bed.clock.now());
    const events = watchShell();
    const path = fileOf("pi-1");
    const claim = bed.service.scanPort.claim(path, headerOf("pi-1"));
    expect(claim.kind).toBe("session");
    const sessionId = claim.kind === "session" ? claim.sessionId : "";
    expect(bed.store.get(sessionId)).toMatchObject({
      piPath: path,
      piSessionId: "pi-1",
      cwd: bed.work,
      ownerId: "u1",
      createdAt: NOW - 10_000,
      updatedAt: NOW - 10_000,
    });
    expect(bed.store.marks.row(sessionId)?.projectId).toBe(`p:${bed.work}`);
    expect(spy.calls).toEqual([{ id: sessionId, stored: true }]);
    await drain();
    const kinds = events().map((event) => event.kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("project");

    expect(bed.service.scanPort.claim(path, headerOf("pi-1"))).toEqual({
      kind: "session",
      sessionId,
      ownerId: "u1",
    });
    expect(rowCount()).toBe(1);
    expect(spy.calls).toHaveLength(1);
  });

  it("caps the header time at now", async () => {
    bed = build();
    await bed.clock.advance(NOW - bed.clock.now());
    const claim = bed.service.scanPort.claim(fileOf("pi-f"), headerOf("pi-f", NOW + 1_000_000));
    const row = claim.kind === "session" ? bed.store.get(claim.sessionId) : undefined;
    expect(row).toMatchObject({ createdAt: NOW, updatedAt: NOW });
  });

  it("binds the row of pap's own live session, without a new row or onAdopted", async () => {
    const spy = adoptions();
    bed = build({
      onAdopted: spy.hook,
      start: () => ({ kind: "ready", piId: "pi-7", sessionFile: join(bed.sessionsDir, "pi-7.jsonl") }),
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    // The worker is the proof: the pending id, which could have failed to be stored, is not what finds the row.
    bed.db.run("UPDATE sessions SET pending_pi_session_id = NULL");
    const path = fileOf("pi-7");
    expect(bed.service.scanPort.claim(path, headerOf("pi-7"))).toEqual({
      kind: "session",
      sessionId,
      ownerId: "u1",
    });
    expect(rowCount()).toBe(1);
    expect(spy.calls).toEqual([]);
    expect(bed.store.get(sessionId)).toMatchObject({ piPath: path, piSessionId: "pi-7" });

    bed.writePiFile(0);
    bed.emit(0, { type: "agent_start" });
    await drain();
    expect(rowCount()).toBe(1);
    expect(bed.store.get(sessionId)).toMatchObject({ piPath: path, piSessionId: "pi-7" });
  });

  it("binds a draft whose worker exited before binding, without a new row or onAdopted", async () => {
    const spy = adoptions();
    bed = build({ onAdopted: spy.hook, start: () => ({ kind: "ready", piId: "pi-8" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await drain();
    const path = fileOf("pi-8");
    expect(bed.service.scanPort.claim(path, headerOf("pi-8"))).toEqual({
      kind: "session",
      sessionId,
      ownerId: "u1",
    });
    expect(rowCount()).toBe(1);
    expect(spy.calls).toEqual([]);
  });

  it("keeps a draft's owner after a restart: the pending id is read from the table (RT-01)", async () => {
    const spy = adoptions();
    bed = build({ start: () => ({ kind: "ready", piId: "pi-8" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await drain();
    expect(bed.store.marks.findByPendingPiId("pi-8")?.id).toBe(sessionId);
    const path = fileOf("pi-8");
    const restarted = portOver({ onAdopted: spy.hook });
    expect(restarted.claim(path, headerOf("pi-8"))).toEqual({
      kind: "session",
      sessionId,
      ownerId: "u1",
    });
    expect(rowCount()).toBe(1);
    expect(bed.store.get(sessionId)?.piPath).toBe(path);
    expect(spy.calls).toEqual([]);
  });

  it("refuses a second file whose id is the pending id of a draft already bound elsewhere", async () => {
    bed = build({ start: () => ({ kind: "ready", piId: "pi-9" }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await drain();
    bed.db.run("UPDATE sessions SET pi_path = $path, pi_session_id = 'other' WHERE id = $id", {
      path: fileOf("elsewhere"),
      id: sessionId,
    });
    expect(bed.service.scanPort.claim(fileOf("pi-9"), headerOf("pi-9"))).toEqual({
      kind: "skip",
      reason: "duplicate_id",
    });
    expect(rowCount()).toBe(1);
  });

  it("skips a copy: an id already bound at another path, logged once for two attempts", () => {
    const { logger, lines } = captureLogger();
    bed = build({ logger });
    expect(bed.service.scanPort.claim(fileOf("pi-1"), headerOf("pi-1")).kind).toBe("session");
    const copy = fileOf("copy");
    expect(bed.service.scanPort.claim(copy, headerOf("pi-1"))).toEqual({
      kind: "skip",
      reason: "duplicate_id",
    });
    expect(bed.service.scanPort.claim(copy, headerOf("pi-1"))).toEqual({
      kind: "skip",
      reason: "duplicate_id",
    });
    expect(rowCount()).toBe(1);
    expect(lines.filter((line) => line.msg === "session_file_duplicate_id")).toHaveLength(1);
  });

  it("skips a file outside the agent directory's sessions", () => {
    bed = build();
    const outside = join(bed.dir, "outside.jsonl");
    writeFileSync(outside, "");
    expect(bed.service.scanPort.claim(outside, headerOf("pi-o"))).toEqual({
      kind: "skip",
      reason: "not_pi_file",
    });
    expect(rowCount()).toBe(0);
  });

  it("waits while there is no owner, then adopts", () => {
    let owner: string | null = null;
    bed = build({ ownerId: () => owner });
    const path = fileOf("pi-1");
    expect(bed.service.scanPort.claim(path, headerOf("pi-1"))).toEqual({ kind: "wait" });
    expect(rowCount()).toBe(0);
    owner = "u1";
    expect(bed.service.scanPort.claim(path, headerOf("pi-1")).kind).toBe("session");
  });

  it("writes nothing over a read-only store", () => {
    bed = build();
    const adopted = bed.service.scanPort.claim(fileOf("pi-1"), headerOf("pi-1"));
    const id = adopted.kind === "session" ? adopted.sessionId : "";
    const before = bed.store.get(id);
    const readOnly: SessionsStore = { ...bed.store, readOnly: true };
    const port = portOver({ store: readOnly, ownerId: () => "u1", newId: () => "x" });
    expect(port.claim(fileOf("pi-2"), headerOf("pi-2"))).toEqual({ kind: "wait" });
    port.touched(id, NOW, true);
    port.named(id, "Name");
    port.previewed(id, "hello");
    expect(rowCount()).toBe(1);
    expect(bed.store.get(id)).toEqual(before);
    expect(bed.store.marks.row(id)?.preview).toBeNull();
  });
});

describe("what the scanner reports about an adopted session", () => {
  const adopt = async () => {
    bed = build();
    await bed.clock.advance(NOW - bed.clock.now());
    const claim = bed.service.scanPort.claim(fileOf("pi-1"), headerOf("pi-1"));
    const id = claim.kind === "session" ? claim.sessionId : "";
    await drain();
    return id;
  };

  it("moves updatedAt forward only, caps it at now, and publishes only when it moved", async () => {
    const id = await adopt();
    const events = watchShell();
    const port = bed.service.scanPort;
    port.touched(id, NOW - 5_000, false);
    expect(bed.store.get(id)?.updatedAt).toBe(NOW - 5_000);
    await drain();
    expect(events()).toHaveLength(1);
    port.touched(id, NOW - 8_000, false);
    expect(bed.store.get(id)?.updatedAt).toBe(NOW - 5_000);
    await drain();
    expect(events()).toEqual([]);
    port.touched(id, NOW + 1_000_000, false);
    expect(bed.store.get(id)?.updatedAt).toBe(NOW);
  });

  it("un-settles a settled session when the append is active", async () => {
    const id = await adopt();
    bed.store.marks.write(id, { ...NO_MARKS, settledAt: NOW - 1 }, null);
    bed.service.scanPort.touched(id, NOW, false);
    expect(bed.store.marks.row(id)?.marks.settledAt).toBe(NOW - 1);
    bed.service.scanPort.touched(id, NOW, true);
    expect(bed.store.marks.row(id)?.marks.settledAt).toBeNull();
  });

  it("stores a cleaned name, publishing only on a change", async () => {
    const id = await adopt();
    const events = watchShell();
    bed.service.scanPort.named(id, "  New\u202E name ");
    expect(bed.store.get(id)?.name).toBe("New name");
    await drain();
    expect(events()).toHaveLength(1);
    bed.service.scanPort.named(id, "New name");
    await drain();
    expect(events()).toEqual([]);
  });

  it("writes the first preview only", async () => {
    const id = await adopt();
    const events = watchShell();
    bed.service.scanPort.previewed(id, "  first   message ");
    expect(bed.store.marks.row(id)?.preview).toBe("first message");
    await drain();
    expect(events()).toHaveLength(1);
    bed.service.scanPort.previewed(id, "second");
    expect(bed.store.marks.row(id)?.preview).toBe("first message");
    await drain();
    expect(events()).toEqual([]);
  });

  it("answers a summary only to the owner", async () => {
    const id = await adopt();
    expect(bed.service.scanPort.summary(id, "u1")?.id).toBe(id);
    expect(bed.service.scanPort.summary(id, "u2")).toBeNull();
  });
});

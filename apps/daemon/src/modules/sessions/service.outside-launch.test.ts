import {
  appendFileSync,
  lutimesSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
} from "node:fs";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { outsideToolResultsTaint } from "./outside-taint.ts";
import { createScanPort } from "./scan-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const line = (message: object) =>
  `${JSON.stringify({ type: "message", id: "cli", parentId: "a0", timestamp: "2026-10-13T00:00:09.000Z", message })}\n`;
const TOOL_RESULT = line({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "out" }] });
const TEXT = line({ role: "assistant", content: [{ type: "text", text: "typed in the terminal" }] });

/** A session with a Pi file whose worker has ended: pap's last write is stamped. */
async function coldSession(options: BedOptions = {}) {
  bed = build(options);
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  const file = bed.writePiFile(0, [["q0", "r0"]]);
  bed.store.bindPiFile(sessionId, file, "pi-0");
  await bed.clock.advance(5_000);
  bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
  await bed.clock.advance(0);
  return { sessionId, file };
}
const reopen = (sessionId: string) => bed.service.prompt({ sessionId, text: "again" }, OWNER);

const hooked = () => {
  const seen: Array<{ id: string; spawned: number }> = [];
  return {
    seen,
    options: {
      onOutsideToolResults: (id: string) => void seen.push({ id, spawned: bed?.spawned.length ?? 0 }),
    } satisfies BedOptions,
  };
};

describe("what pap remembers of its own last write (MC19 a)", () => {
  it("stamps the time and the file size when a worker ends", async () => {
    const { sessionId, file } = await coldSession();
    expect(bed.store.papWrote(sessionId)).toEqual({ at: bed.clock.now(), size: statSync(file).size });
  });

  it("stamps a file that a fork or a clone made", async () => {
    const { sessionId } = await coldSession();
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    const row = bed.store.get(cloned.sessionId);
    expect(bed.store.papWrote(cloned.sessionId)).toEqual({
      at: bed.clock.now(),
      size: statSync(row?.piPath ?? "").size,
    });
  });
});

describe("across a restart (MC19 a)", () => {
  it("a daemon started later taints what was appended while pap was down, and not pap's own last writes", async () => {
    const { sessionId } = await coldSession();
    const stamp = bed.store.papWrote(sessionId).at ?? 0;
    const seen: string[] = [];
    const restarted = createScanPort({
      store: bed.store,
      agentDir: bed.agentDir,
      clock: bed.clock,
      logger: silentLogger,
      newId: () => "new",
      ownerId: () => "u1",
      livePiSession: () => null,
      assignProject: () => null,
      publisher: { changed: vi.fn(), projectChanged: vi.fn(), countsChanged: vi.fn() },
      activity: () => {},
      summary: () => null,
      onAdopted: () => {},
      onOutsideToolResults: (id) => void seen.push(id),
      startedAt: stamp + 10_000,
      isLive: () => false,
      workerEndedAt: () => null,
      liveIdleSince: () => null,
    });
    restarted.touched(sessionId, stamp, true, true);
    expect(seen).toEqual([]);
    restarted.touched(sessionId, stamp + 5_000, true, true);
    expect(seen).toEqual([sessionId]);
  });
});

describe("a worker never starts on tool results nobody has read (MC19 c)", () => {
  it("taints, before the worker spawns, when tool results were appended after pap's last write", async () => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    appendFileSync(file, TOOL_RESULT);
    await reopen(sessionId);
    expect(h.seen).toEqual([{ id: sessionId, spawned: 1 }]);
    expect(bed.spawned).toHaveLength(2);
  });

  it("does not taint for nothing new, or for text alone", async () => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    appendFileSync(file, TEXT);
    await reopen(sessionId);
    expect(h.seen).toEqual([]);
  });

  it.each([
    ["a line it cannot read", (file: string) => appendFileSync(file, "{ not json\n")],
    ["a half-written line", (file: string) => appendFileSync(file, TEXT.slice(0, 30))],
    ["a file that got shorter", (file: string) => truncateSync(file, statSync(file).size - 5)],
  ])("taints for %s", async (_name, damage) => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    damage(file);
    await reopen(sessionId);
    expect(h.seen.map((s) => s.id)).toEqual([sessionId]);
  });

  it("makes a taint the scanner could not store before it starts the worker", async () => {
    let failing = true;
    const calls: number[] = [];
    const { sessionId } = await coldSession({
      onOutsideToolResults: () => {
        calls.push(bed.spawned.length);
        if (failing) throw new Error("policy down");
      },
    });
    await bed.clock.advance(5_000);
    expect(() => bed.service.scanPort.touched(sessionId, bed.clock.now(), true, true)).toThrow("policy down");
    failing = false;
    await reopen(sessionId);
    expect(calls).toEqual([1, 1]);
    expect(bed.spawned).toHaveLength(2);
  });

  it("refuses to start the worker when the taint cannot be stored", async () => {
    const { sessionId, file } = await coldSession({
      onOutsideToolResults: () => {
        throw new Error("policy down");
      },
    });
    appendFileSync(file, TOOL_RESULT);
    await expect(reopen(sessionId)).rejects.toBeInstanceOf(PapError);
    expect(bed.spawned).toHaveLength(1);
  });
});

/** The file's mtime, as a cp -p, a sync tool or the clock of another machine can set it (seconds for utimes). */
const setMtime = (file: string, ms: number): void => utimesSync(file, ms / 1000, ms / 1000);

describe("the gate of the start check: what changed since pap or the scanner last saw the file (MC21)", () => {
  it("(1) taints an unstamped row when tool results were appended after the scanner last decided", async () => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    bed.store.setPapWrote(sessionId, null, null);
    appendFileSync(file, TOOL_RESULT);
    setMtime(file, (bed.store.get(sessionId)?.updatedAt ?? 0) + 10_000);
    await reopen(sessionId);
    expect(h.seen.map((x) => x.id)).toEqual([sessionId]);
  });

  it("(2) does not taint an unstamped row whose file is unchanged since pap last saw it", async () => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    bed.store.setPapWrote(sessionId, null, null);
    appendFileSync(file, TOOL_RESULT); // pap's own tool result, from before the stamp existed
    setMtime(file, bed.store.get(sessionId)?.updatedAt ?? 0);
    await reopen(sessionId);
    expect(h.seen).toEqual([]);
  });

  /** A real taint (fake policy, the real module) so a Clear and the audit rows can be seen. */
  const withPolicy = () => {
    const policy = fakePolicyPort();
    const audited: Array<{ reason: string }> = [];
    const taint = outsideToolResultsTaint({
      store: { get: (id) => bed.store.get(id) },
      policy,
      audit: { append: (line) => void audited.push(line) },
      logger: captureLogger().logger,
    });
    return { policy, audited, options: { policy, onOutsideToolResults: taint } satisfies BedOptions };
  };
  /** The scanner reads an outside tool result at `mtime` (the clock has passed it, as in production) and taints. */
  async function scannerTaints(sessionId: string, file: string) {
    const mtime = bed.clock.now() + 1_000;
    appendFileSync(file, TOOL_RESULT);
    setMtime(file, mtime);
    await bed.clock.advance(5_000);
    bed.service.scanPort.touched(sessionId, mtime, true, true);
  }

  it("(3) keeps a Clear made while the session is closed: reopening with nothing new does not taint again", async () => {
    const w = withPolicy();
    const { sessionId, file } = await coldSession(w.options);
    await scannerTaints(sessionId, file);
    expect(w.policy.taintOf(sessionId).tainted).toBe(true);
    w.policy.clearTaint("u1", sessionId);
    await reopen(sessionId);
    expect(w.policy.taintOf(sessionId).tainted).toBe(false);
    expect(w.audited.filter((line) => line.reason === "tainted_outside")).toHaveLength(1);
  });

  it("(4) taints again when something was appended after the Clear", async () => {
    const w = withPolicy();
    const { sessionId, file } = await coldSession(w.options);
    await scannerTaints(sessionId, file);
    w.policy.clearTaint("u1", sessionId);
    appendFileSync(file, TOOL_RESULT);
    setMtime(file, bed.clock.now() + 1_000);
    await reopen(sessionId);
    expect(w.policy.taintOf(sessionId).tainted).toBe(true);
    expect(w.audited.filter((line) => line.reason === "tainted_outside")).toHaveLength(2);
  });

  it("treats a file replaced by a link as changed, whatever its mtime", async () => {
    const h = hooked();
    const { sessionId, file } = await coldSession(h.options);
    renameSync(file, `${file}.real`);
    symlinkSync(`${file}.real`, file);
    setMtime(`${file}.real`, 1_000);
    lutimesSync(file, 1, 1); // the link itself looks old too
    await reopen(sessionId);
    expect(h.seen.map((x) => x.id)).toEqual([sessionId]);
  });
});

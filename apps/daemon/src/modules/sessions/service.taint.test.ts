import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditPort } from "../audit/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf, policyUpdatesOf } from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options?: BedOptions): typeof bed => (bed = build(options));
afterEach(() => bed.dispose());

const TWO: ReadonlyArray<readonly [string, string]> = [
  ["q0", "r0"],
  ["q1", "r1"],
];
const taintRecord = (epoch: number) => ({ type: "taint", epoch }) as const;
const fakeAudit = () => {
  const calls: unknown[] = [];
  const port: AuditPort = {
    append: () => {},
    fromWorker: (_row, raw) => {
      calls.push(raw);
      return null;
    },
  };
  return { calls, port };
};

/** A stored session whose worker wrote its Pi file: fork and clone can cut it. */
async function boundSession() {
  const { sessionId } = await bed.service.create(bed.work, OWNER);
  bed.store.bindPiFile(sessionId, bed.writePiFile(0, TWO), "pi-0");
  return sessionId;
}

describe("the taint a worker reports (M5R60)", () => {
  it("is stored, pushed back and told to the subscribers; the same report again changes nothing", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    bed.spawned[0]?.emit(taintRecord(0));
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 0 });
    expect(policyUpdatesOf(bed.spawned[0]).at(-1)).toMatchObject({
      rules: { taint: { tainted: true, epoch: 0 } },
    });
    expect(frames.map((frame) => frame.event)).toContainEqual({
      kind: "policy",
      policy: { mode: "auto-accept-edits", explicit: false, tainted: true },
    });
    const updates = policyUpdatesOf(bed.spawned[0]).length;
    bed.spawned[0]?.emit(taintRecord(0));
    expect(policyUpdatesOf(bed.spawned[0])).toHaveLength(updates);
    expect(bed.db.get("SELECT COUNT(*) AS n FROM session_events WHERE kind = 'taint'")).toEqual({ n: 0 });
  });

  it("is ignored when it was observed before a clear, and accepted once the worker has the new epoch", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(taintRecord(0));
    policy.clearTaint(OWNER.userId, sessionId);
    expect(policy.taintOf(sessionId)).toEqual({ tainted: false, epoch: 1 });
    bed.spawned[0]?.emit(taintRecord(0));
    expect(policy.taintOf(sessionId)).toEqual({ tainted: false, epoch: 1 });
    bed.spawned[0]?.emit(taintRecord(1));
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 1 });
  });

  it("sent before the row is stored is held and stored once the row exists", async () => {
    const policy = fakePolicyPort();
    open({
      policy,
      start: () => ({ kind: "ready", before: [taintRecord(0)] }),
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 0 });
  });
});

describe("the taint an external result entry says, even a refused one (M5R60, path 2)", () => {
  const entry = {
    kind: "result",
    toolCallId: "c",
    tool: "mcp__x__y",
    stages: [],
    redactions: -1,
    external: true,
  };

  it("taints the session and still goes to the audit module", async () => {
    const policy = fakePolicyPort();
    const audit = fakeAudit();
    open({ policy, audit: audit.port });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({ type: "audit", entry });
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 0 });
    expect(audit.calls).toEqual([entry]);
  });

  it("raises the taint again after a clear: it carries no epoch", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    policy.clearTaint(OWNER.userId, sessionId);
    bed.spawned[0]?.emit({ type: "audit", entry });
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 1 });
  });

  it("does not taint on a call entry, a result that is not external, or no entry at all", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    for (const other of [
      { ...entry, kind: "call" },
      { ...entry, external: false },
      { ...entry, external: "true" },
      undefined,
    ])
      bed.spawned[0]?.emit({ type: "audit", entry: other });
    expect(policy.taintOf(sessionId)).toEqual({ tainted: false, epoch: 0 });
  });

  it("keeps the session running when the policy port throws on the taint", async () => {
    const policy = fakePolicyPort();
    policy.markTainted = () => {
      throw new PapError("not_found");
    };
    const audit = fakeAudit();
    open({ policy, audit: audit.port });
    await bed.service.create(bed.work, OWNER);
    expect(() => bed.spawned[0]?.emit({ type: "audit", entry })).not.toThrow();
    expect(audit.calls).toEqual([entry]);
  });
});

describe("forks and clones (M5R55)", () => {
  it("take their source's mode and taint", async () => {
    const policy = fakePolicyPort();
    open({ policy });
    const sessionId = await boundSession();
    policy.setMode(OWNER.userId, sessionId, "supervised");
    policy.markTainted(OWNER.userId, sessionId);
    const forked = await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
    const cloned = await bed.service.clone({ sessionId }, OWNER);
    for (const id of [forked.sessionId, cloned.sessionId])
      expect(policy.sessionPolicy(OWNER.userId, id)).toEqual({
        mode: "supervised",
        explicit: true,
        taint: { tainted: true, epoch: 0 },
      });
  });

  it("are removed, file and row, when taking the policy fails", async () => {
    const policy = fakePolicyPort();
    policy.inherit = () => {
      throw new PapError("not_found");
    };
    open({ policy });
    const sessionId = await boundSession();
    const before = bed.service.list(OWNER).map((s) => s.id);
    await expect(bed.service.clone({ sessionId }, OWNER)).rejects.toMatchObject({ code: "not_found" });
    expect(bed.service.list(OWNER).map((s) => s.id)).toEqual(before);
    expect(bed.db.get("SELECT COUNT(*) AS n FROM sessions")).toEqual({ n: before.length });
  });
});

describe("a worker that starts (M5R59)", () => {
  async function reopening(
    whileUp: (policy: ReturnType<typeof fakePolicyPort>, id: string) => void = () => {},
  ) {
    const policy = fakePolicyPort();
    open({ policy, start: (index) => (index === 1 ? { kind: "silent" } : undefined) });
    const sessionId = await boundSession();
    whileUp(policy, sessionId);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    return { policy, sessionId };
  }

  it("is pushed a mode and a taint that arrive between its spawn and its ready, once, after ready", async () => {
    const { policy, sessionId } = await reopening();
    void bed.service.prompt({ sessionId, text: "again" }, OWNER).catch(() => {});
    await bed.clock.advance(0);
    expect(bed.spawned).toHaveLength(2);
    const worker = bed.spawned[1];
    expect(initRecordOf(worker).policy).toMatchObject({
      approvalMode: "auto-accept-edits",
      taint: { tainted: false, epoch: 0 },
    });
    policy.setMode(OWNER.userId, sessionId, "read-only");
    policy.markTainted(OWNER.userId, sessionId);
    expect(policyUpdatesOf(worker)).toEqual([]);
    worker?.emit({
      type: "ready",
      sessionId: "pi-0",
      sessionFile: bed.writePiFile(0, TWO),
      piVersion: "1.1.0",
      leafId: null,
      sessionName: null,
    });
    await bed.clock.advance(0);
    expect(policyUpdatesOf(worker)).toHaveLength(1);
    expect(policyUpdatesOf(worker)[0]).toMatchObject({
      rules: { approvalMode: "read-only", taint: { tainted: true, epoch: 0 } },
    });
  });

  it("starts tainted after a restart: the daemon kept the taint, and the init carries it", async () => {
    const { policy, sessionId } = await reopening((_policy, id) => {
      bed.spawned[0]?.emit(taintRecord(0));
      expect(_policy.taintOf(id)).toEqual({ tainted: true, epoch: 0 });
    });
    expect(policy.taintOf(sessionId)).toEqual({ tainted: true, epoch: 0 });
    void bed.service.prompt({ sessionId, text: "again" }, OWNER).catch(() => {});
    await bed.clock.advance(0);
    expect(initRecordOf(bed.spawned[1]).policy).toMatchObject({ taint: { tainted: true, epoch: 0 } });
  });
});

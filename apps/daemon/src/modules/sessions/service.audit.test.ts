import { afterEach, describe, expect, it } from "vitest";
import type { AuditPort } from "../audit/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

interface Call {
  readonly session: { id: string; ownerId: string };
  readonly raw: unknown;
  readonly containment: string;
}
const fakeAudit = () => {
  const calls: Call[] = [];
  const port: AuditPort = {
    append: () => {},
    reserve: () => true,
    fromWorker: (session, raw, context) => {
      calls.push({
        session: { id: session.id, ownerId: session.ownerId },
        raw,
        containment: context.containment,
      });
      return null;
    },
  };
  return { calls, port };
};

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
const owner = testCaller();
const entry = { kind: "call", toolCallId: "t1", tool: "bash" };

describe("a worker's audit record", () => {
  it("reaches the audit module with the session's row and the containment, and not session_events", async () => {
    const { calls, port } = fakeAudit();
    bed = build({ audit: port, containment: "scope" });
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit({ type: "audit", entry });
    expect(calls).toEqual([{ session: { id: "p1", ownerId: "u1" }, raw: entry, containment: "scope" }]);
    expect(bed.db.get("SELECT COUNT(*) AS n FROM session_events WHERE kind = 'policy'")).toEqual({ n: 0 });
  });

  it("holds a record sent before ready and delivers it once the row exists", async () => {
    const { calls, port } = fakeAudit();
    const seen: string[] = [];
    bed = build({
      audit: {
        append: port.append,
        reserve: () => true,
        fromWorker: (session, raw, context) => {
          seen.push(bed.store.get(session.id) ? "row" : "no row");
          return port.fromWorker(session, raw, context);
        },
      },
      start: () => ({ kind: "ready", before: [{ type: "audit", entry }] }),
    });
    await bed.service.create(bed.work, owner);
    expect(calls).toHaveLength(1);
    expect(seen).toEqual(["row"]);
  });

  it("reaches the audit module even when its entry is malformed (it travels as unknown)", async () => {
    const { calls, port } = fakeAudit();
    bed = build({ audit: port });
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit({ type: "audit", entry: { kind: "call", tool: 7 } });
    bed.spawned[0]?.emit({ type: "audit" });
    expect(calls.map((c) => c.raw)).toEqual([{ kind: "call", tool: 7 }, undefined]);
  });

  it("does not fail the session when the audit module throws", async () => {
    bed = build({
      audit: {
        append: () => {},
        reserve: () => true,
        fromWorker: () => {
          throw new Error("boom");
        },
      },
    });
    await bed.service.create(bed.work, owner);
    expect(() => bed.spawned[0]?.emit({ type: "audit", entry })).not.toThrow();
    expect(bed.service.list(owner)).toHaveLength(1);
  });
});

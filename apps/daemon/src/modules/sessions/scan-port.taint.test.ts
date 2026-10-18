import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createScanPort, MAX_OUTSIDE_WRITES } from "./scan-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const T = 1_800_000_000_000;
const rowOf = (id: string) => {
  bed.store.insert(
    {
      id,
      piPath: null,
      piSessionId: null,
      cwd: bed.work,
      ownerId: "u1",
      name: null,
      createdAt: T,
      updatedAt: T,
    },
    null,
  );
  return id;
};
function portWith(hook: (id: string) => void, live = new Set<string>(), startedAt = T) {
  const changed = vi.fn();
  const port = createScanPort({
    store: bed.store,
    agentDir: bed.agentDir,
    clock: bed.clock,
    logger: silentLogger,
    newId: () => "new",
    ownerId: () => "u1",
    livePiSession: () => null,
    assignProject: () => null,
    publisher: { changed, projectChanged: vi.fn(), countsChanged: vi.fn() },
    activity: () => {},
    summary: () => null,
    onAdopted: () => {},
    onOutsideToolResults: hook,
    startedAt,
    isLive: (id) => live.has(id),
    workerEndedAt: () => null,
    liveIdleSince: () => null,
  });
  return { port, changed };
}

describe("a taint that cannot be stored is owed until it is (MC19 b)", () => {
  it("taints before anything else, so a failing hook leaves the row, the activity and the publish alone", () => {
    bed = build();
    const id = rowOf("s1");
    bed.store.touch(id, 1);
    const { port, changed } = portWith(
      () => {
        throw new Error("policy down");
      },
      new Set(),
      0,
    );
    const at = bed.clock.now();
    expect(at).toBeGreaterThan(1);
    expect(() => port.touched(id, at, true, true)).toThrow("policy down");
    expect(bed.store.get(id)?.updatedAt).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    expect(port.outsideWriteAt(id)).toBe(at);
  });

  it("retries after a throw even when a pap worker started in between, then forgets it", () => {
    bed = build();
    const id = rowOf("s1");
    const live = new Set<string>();
    let failing = true;
    const calls: string[] = [];
    const { port } = portWith((sessionId) => {
      calls.push(sessionId);
      if (failing) throw new Error("policy down");
    }, live);
    expect(() => port.touched(id, T + 10, true, true)).toThrow();
    live.add(id);
    failing = false;
    port.touched(id, T + 10, true, true);
    expect(calls).toEqual(["s1", "s1"]);
    port.touched(id, T + 20, true, true);
    expect(calls).toEqual(["s1", "s1"]);
  });

  it("keeps a bounded set: when it is full, a new failure is not owed and nothing is evicted", () => {
    bed = build();
    const live = new Set<string>();
    const failing = new Set<string>();
    const calls: string[] = [];
    const { port } = portWith((sessionId) => {
      calls.push(sessionId);
      if (failing.has(sessionId)) throw new Error("policy down");
    }, live);
    const ids = Array.from({ length: MAX_OUTSIDE_WRITES + 1 }, (_, i) => rowOf(`m${i}`));
    for (const id of ids) {
      failing.add(id);
      expect(() => port.touched(id, T + 10, true, true)).toThrow();
    }
    calls.length = 0;
    failing.clear();
    for (const id of ids) live.add(id);
    for (const id of ids) port.touched(id, T + 10, true, false);
    expect(calls).toEqual(ids.slice(0, MAX_OUTSIDE_WRITES));
  });

  it("settles an owed taint on demand, for the launch of a worker", () => {
    bed = build();
    const id = rowOf("s1");
    let failing = true;
    const calls: string[] = [];
    const { port } = portWith((sessionId) => {
      calls.push(sessionId);
      if (failing) throw new Error("policy down");
    });
    expect(() => port.touched(id, T + 10, true, true)).toThrow();
    expect(() => port.settleOwed(id)).toThrow("policy down");
    failing = false;
    port.settleOwed(id);
    port.settleOwed(id);
    expect(calls).toEqual(["s1", "s1", "s1"]);
  });
});

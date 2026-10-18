import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createOutsideWrites, OUTSIDE_WRITE_MS } from "./outside-writes.ts";
import { createScanPort, LIVE_GRACE_MS } from "./scan-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const T = 1_800_000_000_000;

/** A live session whose idle time is `idleSince` (null: busy), over the bed's database. */
function livePort(idleSince: number | null, onTaint: (id: string) => void = () => {}) {
  bed = build();
  bed.store.insert(
    {
      id: "s1",
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
  return createScanPort({
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
    onOutsideToolResults: onTaint,
    startedAt: T - 1_000_000,
    isLive: () => true,
    workerEndedAt: () => null,
    liveIdleSince: () => idleSince,
  });
}

describe("a live session's file changed outside pap (spec D 3, M13R13)", () => {
  it("(a) is not outside inside the grace after the last touch", () => {
    const port = livePort(T);
    port.touched("s1", T + 3_000, false, false);
    port.touched("s1", T + LIVE_GRACE_MS, false, false);
    expect(port.outsideWriteAt("s1")).toBeNull();
  });

  it("(b) is outside once the write is later than the grace", () => {
    const port = livePort(T);
    port.touched("s1", T + 11_000, false, false);
    expect(port.outsideWriteAt("s1")).toBe(T + 11_000);
    port.touched("s1", T + LIVE_GRACE_MS + 1, false, false);
    expect(port.outsideWriteAt("s1")).toBe(T + LIVE_GRACE_MS + 1);
  });

  it("(c) is never outside while the worker has work pending", () => {
    const port = livePort(null);
    port.touched("s1", T + 600_000, false, false);
    expect(port.outsideWriteAt("s1")).toBeNull();
  });

  it("(e) shows for 119 s and not at 121 s", () => {
    bed = build();
    const outside = createOutsideWrites(bed.clock);
    const at = bed.clock.now();
    expect(outside.recent(at - 119_000)).toBe(true);
    expect(outside.recent(at - 121_000)).toBe(false);
    expect(OUTSIDE_WRITE_MS).toBe(120_000);
  });

  it("(f) never taints for a live outside tool result", () => {
    const seen: string[] = [];
    const port = livePort(T, (id) => void seen.push(id));
    port.touched("s1", T + 60_000, true, true);
    expect(port.outsideWriteAt("s1")).toBe(T + 60_000);
    expect(seen).toEqual([]);
  });
});

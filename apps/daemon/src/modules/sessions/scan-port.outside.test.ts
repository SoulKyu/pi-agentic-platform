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
    onOutsideToolResults: () => {},
    startedAt: 0,
    isLive: () => false,
    workerEndedAt: () => null,
    liveIdleSince: () => null,
    ...overrides,
  });

describe("outside writes (owner Q13)", () => {
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
  const outsidePort = (live = new Set<string>(), ended = new Map<string, number>()) =>
    portOver({ startedAt: T, isLive: (id) => live.has(id), workerEndedAt: (id) => ended.get(id) ?? null });

  it("remembers the latest write the scanner saw on a cold session", () => {
    bed = build();
    const port = outsidePort();
    const id = rowOf("s1");
    port.touched(id, T + 10, false, false);
    expect(port.outsideWriteAt(id)).toBe(T + 10);
    port.touched(id, T + 20, false, false);
    expect(port.outsideWriteAt(id)).toBe(T + 20);
  });

  it("ignores a live session", () => {
    bed = build();
    const port = outsidePort(new Set(["live"]));
    port.touched(rowOf("live"), T + 10, false, false);
    expect(port.outsideWriteAt("live")).toBeNull();
  });

  it("ignores a write before this daemon started", () => {
    bed = build();
    const port = outsidePort();
    port.touched(rowOf("old"), T - 1, false, false);
    expect(port.outsideWriteAt("old")).toBeNull();
  });

  it("ignores a write that is not later than the end of the session's last pap worker", () => {
    bed = build();
    const port = outsidePort(new Set(), new Map([["s1", T + 50]]));
    const id = rowOf("s1");
    port.touched(id, T + 40, false, false);
    expect(port.outsideWriteAt(id)).toBeNull();
    port.touched(id, T + 60, false, false);
    expect(port.outsideWriteAt(id)).toBe(T + 60);
  });

  it("forgets the oldest session past MAX_OUTSIDE_WRITES", () => {
    bed = build();
    const port = outsidePort();
    const ids = Array.from({ length: MAX_OUTSIDE_WRITES + 1 }, (_, i) => rowOf(`m${i}`));
    ids.forEach((id, i) => port.touched(id, T + 1 + i, false, false));
    expect(port.outsideWriteAt(ids[0] as string)).toBeNull();
    expect(port.outsideWriteAt(ids[1] as string)).toBe(T + 2);
    expect(port.outsideWriteAt(ids[MAX_OUTSIDE_WRITES] as string)).toBe(T + 1 + MAX_OUTSIDE_WRITES);
  });
});

describe("tool results added outside pap (decision 75 Q5, M7R27)", () => {
  const T = 1_800_000_000_000;
  const seen: string[] = [];
  const toolPort = (live = new Set<string>(), ended = new Map<string, number>()) => {
    seen.length = 0;
    return portOver({
      startedAt: T,
      isLive: (id) => live.has(id),
      workerEndedAt: (id) => ended.get(id) ?? null,
      onOutsideToolResults: (id) => void seen.push(id),
    });
  };
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

  it("calls the hook once for an outside chunk with tool results", () => {
    bed = build();
    toolPort().touched(rowOf("s1"), T + 10, true, true);
    expect(seen).toEqual(["s1"]);
  });

  it("never calls it for an outside chunk without tool results", () => {
    bed = build();
    const port = toolPort();
    port.touched(rowOf("s1"), T + 10, true, false);
    port.touched("s1", T + 20, false, false);
    expect(seen).toEqual([]);
    expect(port.outsideWriteAt("s1")).toBe(T + 20);
  });

  it("never calls it while a pap worker holds the session", () => {
    bed = build();
    toolPort(new Set(["s1"])).touched(rowOf("s1"), T + 10, true, true);
    expect(seen).toEqual([]);
  });

  it("calls it for a chunk written while the daemon was down, after pap's own last write (MC19 a)", () => {
    bed = build();
    const id = rowOf("s1");
    bed.store.setPapWrote(id, T - 100, null);
    toolPort().touched(id, T - 1, true, true);
    expect(seen).toEqual(["s1"]);
  });

  it("never calls it for a chunk pap wrote itself before a restart (at or before the stored stamp)", () => {
    bed = build();
    const id = rowOf("s1");
    bed.store.setPapWrote(id, T - 1, null);
    const restarted = toolPort();
    restarted.touched(id, T - 1, true, true);
    restarted.touched(id, T - 50, true, true);
    expect(seen).toEqual([]);
    restarted.touched(id, T, true, true);
    expect(seen).toEqual(["s1"]);
  });

  it("never calls it for a chunk not later than the end of the last pap worker", () => {
    bed = build();
    const port = toolPort(new Set(), new Map([["s1", T + 50]]));
    port.touched(rowOf("s1"), T + 50, true, true);
    expect(seen).toEqual([]);
    port.touched("s1", T + 51, true, true);
    expect(seen).toEqual(["s1"]);
  });

  it("does nothing for a session the table does not know", () => {
    bed = build();
    toolPort().touched("ghost", T + 10, true, true);
    expect(seen).toEqual([]);
  });
});

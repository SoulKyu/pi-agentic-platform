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
    startedAt: 0,
    isLive: () => false,
    workerEndedAt: () => null,
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
    port.touched(id, T + 10, false);
    expect(port.outsideWriteAt(id)).toBe(T + 10);
    port.touched(id, T + 20, false);
    expect(port.outsideWriteAt(id)).toBe(T + 20);
  });

  it("ignores a live session, and a write before this daemon started", () => {
    bed = build();
    const port = outsidePort(new Set(["live"]));
    port.touched(rowOf("live"), T + 10, false);
    expect(port.outsideWriteAt("live")).toBeNull();
    port.touched(rowOf("old"), T - 1, false);
    expect(port.outsideWriteAt("old")).toBeNull();
  });

  it("ignores a write that is not later than the end of the session's last pap worker", () => {
    bed = build();
    const port = outsidePort(new Set(), new Map([["s1", T + 50]]));
    const id = rowOf("s1");
    port.touched(id, T + 40, false);
    expect(port.outsideWriteAt(id)).toBeNull();
    port.touched(id, T + 60, false);
    expect(port.outsideWriteAt(id)).toBe(T + 60);
  });

  it("forgets the oldest session past MAX_OUTSIDE_WRITES", () => {
    bed = build();
    const port = outsidePort();
    const ids = Array.from({ length: MAX_OUTSIDE_WRITES + 1 }, (_, i) => rowOf(`m${i}`));
    ids.forEach((id, i) => port.touched(id, T + 1 + i, false));
    expect(port.outsideWriteAt(ids[0] as string)).toBeNull();
    expect(port.outsideWriteAt(ids[1] as string)).toBe(T + 2);
    expect(port.outsideWriteAt(ids[MAX_OUTSIDE_WRITES] as string)).toBe(T + 1 + MAX_OUTSIDE_WRITES);
  });
});

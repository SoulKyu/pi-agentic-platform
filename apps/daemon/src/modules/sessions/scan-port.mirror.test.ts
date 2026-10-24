import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createScanPort, type PiFileHeader } from "./scan-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

/** The bed keeps pap's home beside the agent folder. */
const papHome = () => join(dirname(bed.agentDir), "pap");
const T = 1_800_000_000_000;
const headerOf = (id: string): PiFileHeader => ({ id, cwd: bed.work, createdAt: T - 10_000 });
const mirrorFile = (parent: "agents" | "boxes", box: string, name: string): string => {
  const folder = join(papHome(), parent, ".mirrors", box);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, "");
  return path;
};
const rowAt = (id: string, piPath: string | null) =>
  bed.store.insert(
    {
      id,
      piPath,
      piSessionId: piPath === null ? null : `pi-${id}`,
      cwd: bed.work,
      ownerId: "u1",
      name: null,
      createdAt: T,
      updatedAt: T,
    },
    null,
  );
const rowCount = () => bed.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n ?? 0;

const portOver = (seen: string[] = [], adopted: string[] = []) =>
  createScanPort({
    store: bed.store,
    agentDir: bed.agentDir,
    mirrorRoots: [join(papHome(), "agents", ".mirrors"), join(papHome(), "boxes", ".mirrors")],
    clock: bed.clock,
    logger: silentLogger,
    newId: () => "new",
    ownerId: () => "u1",
    livePiSession: () => null,
    assignProject: () => null,
    publisher: { changed: vi.fn(), projectChanged: vi.fn(), countsChanged: vi.fn() },
    activity: () => {},
    summary: () => null,
    onAdopted: (id) => void adopted.push(id),
    onOutsideToolResults: (id) => void seen.push(id),
    startedAt: T,
    isLive: () => false,
    workerEndedAt: () => null,
    liveIdleSince: () => null,
  });

describe("mirrors of VM sessions", () => {
  it("indexes a known mirror file", () => {
    bed = build();
    for (const parent of ["agents", "boxes"] as const) {
      const path = mirrorFile(parent, "box-1", `${parent}.jsonl`);
      rowAt(`s-${parent}`, path);
      expect(portOver().claim(path, headerOf(`pi-s-${parent}`))).toEqual({
        kind: "session",
        sessionId: `s-${parent}`,
        ownerId: "u1",
      });
    }
  });

  it("never adopts an unknown file under a mirror root: it waits for its row", () => {
    bed = build();
    const adopted: string[] = [];
    const port = portOver([], adopted);
    const path = mirrorFile("boxes", "box-1", "stray.jsonl");
    expect(port.claim(path, headerOf("pi-stray"))).toEqual({ kind: "wait" });
    expect(rowCount()).toBe(0);
    expect(adopted).toEqual([]);
    rowAt("late", path);
    expect(port.claim(path, headerOf("pi-late"))).toEqual({
      kind: "session",
      sessionId: "late",
      ownerId: "u1",
    });
    expect(rowCount()).toBe(1);
    expect(adopted).toEqual([]);
  });

  it("a mirror append is not an outside write, a warning or a taint", () => {
    bed = build();
    const seen: string[] = [];
    const port = portOver(seen);
    rowAt("vm", mirrorFile("agents", "a-1", "vm.jsonl"));
    port.touched("vm", T + 10, true, true);
    port.touched("vm", T + 20, false, false);
    expect(port.outsideWriteAt("vm")).toBeNull();
    expect(seen).toEqual([]);
  });

  it("still reports an outside write on a host session file", () => {
    bed = build();
    const seen: string[] = [];
    const port = portOver(seen);
    rowAt("host", join(bed.sessionsDir, "h.jsonl"));
    port.touched("host", T + 10, true, true);
    expect(port.outsideWriteAt("host")).toBe(T + 10);
    expect(seen).toEqual(["host"]);
  });
});

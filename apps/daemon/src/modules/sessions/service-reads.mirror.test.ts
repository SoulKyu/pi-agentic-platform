import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, TranscriptRow } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionReads } from "./service-reads.ts";
import type { SessionRow } from "./store.ts";
import { sessionFileText } from "./testing/pi-file-writers.ts";
import { loadTranscriptReader } from "./transcript.ts";

const AGENT = "atlas-1a2b";
const caller = { userId: "u1" } as Caller;
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mirrorOf = (papHome: string, agent = AGENT) => join(papHome, "agents", ".mirrors", agent, "s.jsonl");

function setup(options: {
  row?: Partial<SessionRow>;
  reported?: (home: string, agentDir: string) => string | null;
}) {
  root = mkdtempSync(join(tmpdir(), "pap-reads-"));
  const papHome = join(root, "pap");
  const agentDir = join(root, "pi");
  for (const agent of [AGENT, "other-9z9z"])
    mkdirSync(join(papHome, "agents", ".mirrors", agent), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const row = {
    id: "s1",
    ownerId: "u1",
    cwd: "/w",
    piPath: null,
    name: null,
    createdAt: 0,
    updatedAt: 0,
    ...options.row,
  } as SessionRow;
  const reported = options.reported?.(papHome, agentDir) ?? null;
  const pages: string[] = [];
  const reader = {
    page: (file: string) => {
      pages.push(file);
      return { rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0, leafId: null };
    },
  };
  const reads = createSessionReads({
    store: { get: () => row, marks: { row: () => undefined } } as never,
    agentDir,
    papHome,
    loadTranscript: () => Promise.resolve(reader as never),
    live: new Map(reported === null ? [] : [["s1", { piFile: () => reported, leafId: () => null } as never]]),
    statusOf: () => "idle",
    owned: () => row,
    outsideWrite: () => false,
    policyView: () => ({}) as never,
    children: () => [],
  });
  return { reads, pages, papHome, agentDir, row };
}
const vmRow: Partial<SessionRow> = { agentId: AGENT, agentRole: "thread" };
const read = (t: ReturnType<typeof setup>) => t.reads.history({ sessionId: "s1", before: "x" }, caller);

describe("the file a VM session is read from (T9b)", () => {
  it("reads the mirror a live VM worker reports before the row has bound it", async () => {
    const t = setup({ row: vmRow, reported: (home) => mirrorOf(home) });
    await read(t);
    expect(t.pages).toEqual([mirrorOf(t.papHome)]);
  });

  it("still reads a file under Pi's sessions folder for a host row", async () => {
    const t = setup({ reported: (_home, agentDir) => join(agentDir, "sessions", "s.jsonl") });
    await read(t);
    expect(t.pages).toEqual([join(t.agentDir, "sessions", "s.jsonl")]);
  });

  it.each([
    ["another agent's mirror", vmRow, (home: string) => mirrorOf(home, "other-9z9z")],
    ["a mirror reported for a host row", {}, (home: string) => mirrorOf(home)],
    ["a file elsewhere", vmRow, (home: string) => join(home, "agents", "s.jsonl")],
  ])("reads nothing from %s", async (_name, row, pathOf) => {
    const t = setup({ row, reported: (home) => pathOf(home) });
    await read(t);
    expect(t.pages).toEqual([]);
  });
});

describe("unverified user entries (R32)", () => {
  async function readsOf(unverified: string[], sidecar: "list" | "link" = "list") {
    const bed = setup({ reported: () => null });
    const path = mirrorOf(bed.papHome);
    writeFileSync(
      path,
      sessionFileText("pi-1", [
        ["hello", "yo"],
        ["forged", "ok"],
      ]),
      { mode: 0o600 },
    );
    if (sidecar === "link") {
      writeFileSync(join(bed.papHome, "elsewhere"), "u1\n");
      symlinkSync(join(bed.papHome, "elsewhere"), `${path}.unverified`);
    } else writeFileSync(`${path}.unverified`, unverified.map((id) => `${id}\n`).join(""), { mode: 0o600 });
    const row = { id: "s1", ownerId: "u1", cwd: "/w", piPath: path, name: null, ...vmRow } as SessionRow;
    const reads = createSessionReads({
      store: { get: () => row, marks: { row: () => undefined } } as never,
      agentDir: bed.agentDir,
      papHome: bed.papHome,
      loadTranscript: () => loadTranscriptReader(),
      live: new Map(),
      statusOf: () => "idle",
      owned: () => row,
      outsideWrite: () => false,
      policyView: () => ({}) as never,
      children: () => [],
    });
    await reads.ensureReader();
    return reads;
  }
  const flagged = (rows: TranscriptRow[]) => rows.filter((row) => row.unverified).map((row) => row.entryId);

  it("marks the rows of a user entry the VM wrote that pap did not send, in the history and in the snapshot", async () => {
    const reads = await readsOf(["u1"]);
    const page = await reads.history({ sessionId: "s1", before: "a1", limit: 50 }, caller);
    expect(page.rows.map((row) => row.entryId)).toContain("u1");
    expect(flagged(page.rows)).toEqual(["u1"]);
    const snapshot = reads.snapshot("s1");
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    expect(flagged(snapshot.rows)).toEqual(["u1"]);
    expect(snapshot.rows.find((row) => row.entryId === "u0")).not.toHaveProperty("unverified");
  });

  it("marks nothing when the sidecar lists nothing", async () => {
    const reads = await readsOf([]);
    const snapshot = reads.snapshot("s1");
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    expect(flagged(snapshot.rows)).toEqual([]);
  });

  // Mutant M-READS-FAILOPEN: an unreadable list marks nothing: killed here (AVM-E22).
  it("marks EVERY user row when the list cannot be read", async () => {
    const reads = await readsOf([], "link");
    const snapshot = reads.snapshot("s1");
    if (snapshot.kind !== "snapshot") throw new Error("no snapshot");
    expect(flagged(snapshot.rows)).toEqual(["u0", "u1"]);
    expect(snapshot.rows.find((row) => row.entryId === "a0")).not.toHaveProperty("unverified");
  });
});

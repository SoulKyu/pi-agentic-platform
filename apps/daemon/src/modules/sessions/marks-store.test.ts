import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_MARKS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createMarksStore, type MarksStore } from "./marks-store.ts";
import { createSessionsStore } from "./store.ts";

let dir: string;
let db: Db;
let marks: MarksStore;
const add = (
  id: string,
  updatedAt: number,
  extra: { ownerId?: string; piPath?: string; piId?: string; projectId?: string } = {},
) =>
  createSessionsStore(db).insert(
    {
      id,
      piPath: extra.piPath ?? null,
      piSessionId: extra.piId ?? null,
      cwd: `/w/${id}`,
      ownerId: extra.ownerId ?? "u1",
      name: null,
      createdAt: 1,
      updatedAt,
    },
    extra.projectId ?? null,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-marks-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  marks = createMarksStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("marks store: subagent sessions (M11R153)", () => {
  const addChild = (id: string, parentSessionId: string) =>
    createSessionsStore(db).insert(
      {
        id,
        piPath: null,
        piSessionId: null,
        cwd: `/w/${id}`,
        ownerId: "u1",
        name: null,
        createdAt: 1,
        updatedAt: 20,
        parentSessionId,
      },
      null,
    );

  it("reads the parent of a child and nothing of a session that has none", () => {
    add("p", 10);
    addChild("c", "p");
    expect(marks.row("c")?.parentId).toBe("p");
    expect(marks.row("p") && "parentId" in (marks.row("p") as object)).toBe(false);
    expect(marks.window("u1", 10).map((row) => [row.id, row.parentId])).toEqual([
      ["c", "p"],
      ["p", undefined],
    ]);
  });
});

describe("marks store", () => {
  it("reads a row with no marks as NO_MARKS", () => {
    add("a", 10, { projectId: "p1" });
    expect(marks.row("a")).toEqual({
      id: "a",
      ownerId: "u1",
      cwd: "/w/a",
      name: null,
      preview: null,
      projectId: "p1",
      createdAt: 1,
      updatedAt: 10,
      toolPreset: "configured",
      marks: NO_MARKS,
    });
    expect(marks.row("nope")).toBeUndefined();
  });

  it("windows the owner's sessions: pinned by rank, then newest, archived left out", () => {
    for (const [id, at] of [
      ["a", 10],
      ["b", 20],
      ["c", 30],
      ["d", 40],
    ] as const)
      add(id, at);
    add("other", 99, { ownerId: "u2" });
    marks.write("a", { ...NO_MARKS, pinRank: 2 }, { ownerId: "u1", order: ["b", "a"] });
    marks.write("d", { ...NO_MARKS, archivedAt: 5 }, null);
    expect(marks.window("u1", 10).map((row) => row.id)).toEqual(["b", "a", "c"]);
    expect(marks.window("u1", 2).map((row) => row.id)).toEqual(["b", "a"]);
    expect(marks.pins("u1")).toEqual(["b", "a"]);
    expect([marks.countActive("u1"), marks.countArchived("u1")]).toEqual([3, 1]);
  });

  it("renumbers the pins it is given and unpins the owner's others", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    marks.write("a", { ...NO_MARKS, pinRank: 1 }, { ownerId: "u1", order: ["a", "b", "c"] });
    marks.write("b", { ...NO_MARKS }, { ownerId: "u1", order: ["c", "a"] });
    expect(marks.pins("u1")).toEqual(["c", "a"]);
    expect(marks.row("b")?.marks.pinRank).toBeNull();
  });

  it("pages archived sessions newest first from a cursor", () => {
    for (const [id, at] of [
      ["a", 3],
      ["b", 1],
      ["c", 2],
    ] as const) {
      add(id, 1);
      marks.write(id, { ...NO_MARKS, archivedAt: at }, null);
    }
    expect(marks.archivedPage("u1", null, 2).map((row) => row.id)).toEqual(["a", "c"]);
    expect(marks.archivedPage("u1", { archivedAt: 2, id: "c" }, 2).map((row) => row.id)).toEqual(["b"]);
  });

  it("counts active sessions per project", () => {
    add("a", 1, { projectId: "p1" });
    add("b", 1, { projectId: "p1" });
    add("c", 1, { projectId: "p2" });
    add("d", 1);
    marks.write("b", { ...NO_MARKS, archivedAt: 1 }, null);
    expect([...marks.activeByProject("u1")].sort()).toEqual([
      ["p1", 1],
      ["p2", 1],
    ]);
    expect(marks.countByProject("u1", "p1")).toBe(1);
  });

  it("sets a preview once, and the project", () => {
    add("a", 1);
    expect(marks.setPreview("a", "first")).toBe(true);
    expect(marks.setPreview("a", "second")).toBe(false);
    marks.setProject("a", "p9");
    expect(marks.row("a")).toMatchObject({ preview: "first", projectId: "p9" });
  });

  it("finds a session by Pi file and by Pi id", () => {
    add("a", 1, { piPath: "/agent/sessions/x/f.jsonl", piId: "pi-1" });
    expect(marks.findByPiPath("/agent/sessions/x/f.jsonl")).toEqual({ id: "a", ownerId: "u1" });
    expect(marks.findByPiSessionId("pi-1")).toEqual({
      id: "a",
      ownerId: "u1",
      piPath: "/agent/sessions/x/f.jsonl",
    });
    expect(marks.findByPiPath("/nope")).toBeUndefined();
  });

  it("keeps every Pi id a draft's workers reported, only while the draft has no file, and after the bind (M4R123, M4R60)", () => {
    add("draft", 1);
    add("bound", 1, { piPath: "/agent/sessions/x/b.jsonl", piId: "pi-b" });
    expect(marks.setPendingPiId("draft", "pi-1")).toBe(true);
    expect(marks.setPendingPiId("draft", "pi-2")).toBe(true);
    expect(marks.setPendingPiId("draft", "pi-2")).toBe(true);
    expect(marks.setPendingPiId("bound", "pi-3")).toBe(false);
    // A later id never replaces an earlier one: the column keeps the first, the table keeps both.
    expect(db.get("SELECT pending_pi_session_id AS id FROM sessions WHERE id = 'draft'")).toEqual({
      id: "pi-1",
    });
    expect(marks.findByPendingPiId("pi-1")).toEqual({ id: "draft", ownerId: "u1", piPath: null });
    expect(marks.findByPendingPiId("pi-2")).toEqual({ id: "draft", ownerId: "u1", piPath: null });
    expect(marks.findByPendingPiId("pi-3")).toBeUndefined();
    createSessionsStore(db).bindPiFile("draft", "/agent/sessions/x/d.jsonl", "pi-2");
    expect(marks.findByPendingPiId("pi-2")).toEqual({
      id: "draft",
      ownerId: "u1",
      piPath: "/agent/sessions/x/d.jsonl",
    });
    add("long", 1);
    expect(() => marks.setPendingPiId("long", "x".repeat(129))).toThrow();
  });

  it("keeps at most 32 pending ids per draft", () => {
    add("many", 1);
    for (let i = 0; i < 40; i++) marks.setPendingPiId("many", `pi-${i}`);
    expect(marks.findByPendingPiId("pi-31")?.id).toBe("many");
    expect(marks.findByPendingPiId("pi-32")).toBeUndefined();
  });

  it("lists sessions without a project page by page", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    add("d", 1, { projectId: "p1" });
    expect(marks.withoutProject("", 2).map((row) => row.id)).toEqual(["a", "b"]);
    expect(marks.withoutProject("b", 2)).toEqual([{ id: "c", ownerId: "u1", cwd: "/w/c" }]);
  });

  it("finds due snoozes and the next one", () => {
    for (const id of ["a", "b", "c"]) add(id, 1);
    marks.write("a", { ...NO_MARKS, snoozedUntil: 100 }, null);
    marks.write("b", { ...NO_MARKS, snoozedUntil: 50 }, null);
    expect(marks.nextSnooze()).toBe(50);
    expect(marks.dueSnoozes(60, 10)).toEqual(["b"]);
  });

  it("offers for the 3-day rule only idle sessions that are not pinned, snoozed, settled, archived or freshly unsettled", () => {
    for (const id of ["idle", "pinned", "snoozed", "settled", "archived", "unsettled", "fresh"])
      add(id, id === "fresh" ? 500 : 10);
    marks.write("pinned", { ...NO_MARKS, pinRank: 1 }, { ownerId: "u1", order: ["pinned"] });
    marks.write("snoozed", { ...NO_MARKS, snoozedUntil: 9_999 }, null);
    marks.write("settled", { ...NO_MARKS, settledAt: 5 }, null);
    marks.write("archived", { ...NO_MARKS, archivedAt: 5 }, null);
    marks.write("unsettled", { ...NO_MARKS, unsettledAt: 400 }, null);
    expect(marks.settleCandidates(100, 10)).toEqual(["idle"]);
  });
});

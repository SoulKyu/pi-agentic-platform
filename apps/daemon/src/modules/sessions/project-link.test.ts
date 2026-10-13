import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createProjectLink } from "./project-link.ts";
import { createSessionsStore, type SessionsStore } from "./store.ts";
import { fakeProjectsPort } from "./testing/fake-projects.ts";
import { captureLogger } from "./testing/helpers.ts";

let dir: string;
let db: Db;
let store: SessionsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-project-link-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  store = createSessionsStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (id: string, cwd: string, ownerId = "u1") =>
  store.insert({ id, piPath: null, piSessionId: null, cwd, ownerId, name: null, createdAt: 1, updatedAt: 1 });
const scopeOf = (cwd: string) => cwd.replace(/\/sub$/, "");
const linkWith = (projects: ProjectsPort, logger = silentLogger) =>
  createProjectLink({ store: store.marks, projects, scopeOf, logger });

describe("project link", () => {
  it("assigns the project of the normalised scope root", () => {
    add("s1", "/w/api/sub");
    const projects = fakeProjectsPort();
    expect(linkWith(projects).assign("s1", "u1", "/w/api/sub")).toBe("p:/w/api");
    expect(store.marks.row("s1")?.projectId).toBe("p:/w/api");
    expect(projects.ensured).toEqual([{ ownerId: "u1", root: "/w/api" }]);
  });

  it("copies the project of a source and does not ask for one", () => {
    add("s1", "/w/api");
    add("s2", "/w/api");
    const projects = fakeProjectsPort();
    const link = linkWith(projects);
    link.assign("s1", "u1", "/w/api");
    projects.ensured.length = 0;
    expect(link.copy("s1", "s2")).toBe("p:/w/api");
    expect(store.marks.row("s2")?.projectId).toBe("p:/w/api");
    expect(projects.ensured).toEqual([]);
  });

  it("backfills once per owner and folder, and logs the count", () => {
    for (const id of ["a1", "a2", "a3"]) add(id, "/w/a");
    add("b1", "/w/b");
    add("c1", "/w/a", "u2");
    const projects = fakeProjectsPort();
    const { logger, lines } = captureLogger();
    expect(linkWith(projects, logger).backfill()).toBe(5);
    expect(projects.ensured).toHaveLength(3);
    expect(store.marks.withoutProject("", 10)).toEqual([]);
    expect(lines.filter((line) => line["msg"] === "session_projects_backfilled")).toEqual([
      expect.objectContaining({ sessions: 5 }),
    ]);
  });

  it("files a row under its own owner's project, never another's", () => {
    add("c1", "/w/a", "u2");
    const projects = fakeProjectsPort();
    linkWith(projects).backfill();
    expect(projects.ensured).toEqual([{ ownerId: "u2", root: "/w/a" }]);
  });

  it("leaves a row whose project cannot be made without one, and ends", () => {
    add("bad1", "/w/bad");
    const { logger, lines } = captureLogger();
    const link = linkWith(fakeProjectsPort({ refuse: ["/w/bad"] }), logger);
    expect(link.backfill()).toBe(0);
    expect(link.backfill()).toBe(0);
    expect(store.marks.row("bad1")?.projectId).toBeNull();
    expect(store.marks.withoutProject("", 10)).toEqual([expect.objectContaining({ id: "bad1" })]);
    expect(lines.filter((line) => line["msg"] === "session_projects_backfilled")).toEqual([]);
  });

  it("pages past a row it could not file, by id", () => {
    for (let n = 0; n < 502; n++) add(`r${String(n).padStart(4, "0")}`, n === 0 ? "/w/bad" : "/w/ok");
    expect(linkWith(fakeProjectsPort({ refuse: ["/w/bad"] })).backfill()).toBe(501);
  });

  it("answers null and logs once when the port throws", () => {
    const { logger, lines } = captureLogger();
    const throwing: ProjectsPort = {
      ...fakeProjectsPort(),
      ensure: () => {
        throw new Error("attempt to write a readonly database");
      },
    };
    expect(linkWith(throwing, logger).projectOf("u1", "/w/a")).toBeNull();
    expect(lines.filter((line) => line["msg"] === "session_project_failed")).toHaveLength(1);
  });
});

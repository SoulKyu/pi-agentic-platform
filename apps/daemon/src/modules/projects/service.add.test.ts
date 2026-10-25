import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { resolveSessionCwd } from "../sessions/index.ts";
import { createProjectsService, MAX_PROJECTS, type ProjectFolders } from "./service.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

let bed: ReturnType<typeof createProjectsBed>;
let dir: string;
let folders: ProjectFolders;
const at = (...parts: string[]) => join(dir, ...parts);
const u1 = testCaller({ userId: "u1" });

const build = (rules: ProjectFolders | null = folders) =>
  createProjectsService({
    isMember: () => false,
    boxes: createBoxStore(bed.db),
    store: createProjectsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
    ...(rules === null ? {} : { folders: rules }),
  });

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return undefined;
};

beforeEach(() => {
  bed = createProjectsBed();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-add-")));
  for (const folder of [
    "work/repo/.git",
    "work/repo/src",
    "work/plain",
    "pap/worktrees/lane-1a2b",
    "agent/sessions",
  ])
    mkdirSync(at(folder), { recursive: true });
  writeFileSync(at("work", "notes.txt"), "x");
  symlinkSync(at("pap"), at("work", "to-pap"));
  symlinkSync(at("agent", "sessions"), at("work", "to-agent"));
  folders = {
    resolve: resolveSessionCwd,
    // What `policy.scopeOf` answers here: the repository root for a folder inside it, else the folder.
    scopeOf: (real) =>
      real === at("work", "repo") || real.startsWith(`${at("work", "repo")}/`) ? at("work", "repo") : real,
    stateDirs: [at("pap"), at("agent")],
  };
});
afterEach(() => {
  bed.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("projects.add (decision 85)", () => {
  it("files a folder under its git root, named after it, and answers one project for every spelling of it", () => {
    const projects = build();
    const repo = projects.add(u1, at("work", "repo", "src"));
    expect(repo).toMatchObject({ root: at("work", "repo"), name: "repo" });
    expect(projects.add(u1, at("work", "repo")).id).toBe(repo.id);
    const plain = projects.add(u1, at("work", "plain"));
    expect(plain.root).toBe(at("work", "plain"));
    // Review Focus 4: a trailing slash and a `..` segment are the same real folder, so the same project.
    expect(projects.add(u1, `${at("work", "plain")}/`).id).toBe(plain.id);
    expect(projects.add(u1, `${at("work", "repo")}/../plain`).id).toBe(plain.id);
    expect(projects.list("u1", [repo.id, plain.id])).toHaveLength(2);
  });

  it("answers invalid_cwd for a relative, home-relative, missing or file path", () => {
    const projects = build();
    for (const root of ["work/plain", "~/plain", at("work", "missing"), at("work", "notes.txt")])
      expect(
        codeOf(() => projects.add(u1, root)),
        root,
      ).toBe("invalid_cwd");
  });

  it("refuses pap's home, Pi's agent folder, anything inside them and a link into them (Review Focus 4)", () => {
    const projects = build();
    for (const root of [
      at("pap"),
      at("pap", "worktrees", "lane-1a2b"),
      at("agent"),
      at("agent", "sessions"),
      at("work", "to-pap"),
      at("work", "to-agent"),
    ])
      expect(
        codeOf(() => projects.add(u1, root)),
        root,
      ).toBe("bad_request");
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n).toBe(0);
  });

  it("refuses a folder in pap's home when the home itself is given as a link", () => {
    symlinkSync(at("pap"), at("pap-link"));
    const projects = build({ ...folders, stateDirs: [at("pap-link"), at("agent")] });
    expect(codeOf(() => projects.add(u1, at("pap", "worktrees", "lane-1a2b")))).toBe("bad_request");
  });

  it("refuses a real folder in a state folder even when its scope is somewhere else", () => {
    const projects = build({ ...folders, scopeOf: () => at("work", "repo") });
    for (const root of [at("pap", "worktrees", "lane-1a2b"), at("agent", "sessions")])
      expect(
        codeOf(() => projects.add(u1, root)),
        root,
      ).toBe("bad_request");
  });

  it("refuses a scope with a control character", () => {
    mkdirSync(at("work", "a\u000Ab"));
    expect(codeOf(() => build().add(u1, at("work", "a\u000Ab")))).toBe("bad_request");
  });

  it("answers capacity past MAX_PROJECTS, and still answers a project the owner already has", () => {
    const store = createProjectsStore(bed.db);
    // One transaction: 2 000 autocommits are 2 000 fsyncs (M4R130).
    bed.db.transaction(() => {
      for (let i = 0; i < MAX_PROJECTS - 1; i++)
        store.insert({
          id: `x${i}`,
          ownerId: "u1",
          root: `/r/${i}`,
          name: `r${i}`,
          position: i,
          createdAt: 0,
        });
      store.insert({
        id: "kept",
        ownerId: "u1",
        root: at("work", "plain"),
        name: "plain",
        position: 0,
        createdAt: 0,
      });
    });
    const projects = build();
    expect(codeOf(() => projects.add(u1, at("work", "repo")))).toBe("capacity");
    expect(projects.add(u1, at("work", "plain")).id).toBe("kept");
  });

  it("keeps owners apart: one folder is one project per owner", () => {
    const projects = build();
    const mine = projects.add(u1, at("work", "plain"));
    const theirs = projects.add(testCaller({ userId: "u2" }), at("work", "plain"));
    expect(theirs.id).not.toBe(mine.id);
    expect(projects.list("u1", [theirs.id])).toEqual([]);
  });

  it("maps a refused write of a newer database to read_only", () => {
    const store = createProjectsStore(bed.db);
    const projects = createProjectsService({
      isMember: () => false,
      boxes: createBoxStore(bed.db),
      store: {
        ...store,
        insert: () => {
          throw new Error("attempt to write a readonly database");
        },
      },
      clock: bed.clock,
      logger: bed.logger,
      newId: bed.newId,
      folders,
    });
    expect(codeOf(() => projects.add(u1, at("work", "plain")))).toBe("read_only");
  });

  it("fails closed without the folder rules", () => {
    expect(codeOf(() => build(null).add(u1, at("work", "plain")))).toBe("internal");
  });
});

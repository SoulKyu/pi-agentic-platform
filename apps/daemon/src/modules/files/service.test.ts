import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const service = (roots: Record<string, string[]>) =>
  createFilesService({
    isMember: () => false,
    roots: (owner) => roots[owner] ?? [],
    boundary: bed.bb.config(),
    deny: bed.deny,
    git: bed.git,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    workerUmask: 0o022,
  });
const code = async (run: Promise<unknown>) =>
  ((await run.catch((e: unknown) => e)) as { code?: string }).code;

describe("the caller's own roots", () => {
  it("lists, reads and searches the owner's projects", async () => {
    const files = service({ u1: [bed.repo] });
    const caller = testCaller();
    expect((await files.list(caller, { path: bed.repo })).entries.map((e) => e.name)).toContain("a.txt");
    expect((await files.read(caller, { path: join(bed.repo, "a.txt") })).text).toBe("one\n");
    expect(await files.search(caller, { root: bed.repo, query: "atx" })).toEqual({
      paths: ["a.txt"],
      truncated: false,
    });
  });

  it("answers not_found for another owner's project, and for a root that is not exactly one of the caller's", async () => {
    const files = service({ u1: [bed.repo] });
    const other = testCaller({ userId: "u2" });
    expect(await code(files.list(other, { path: bed.repo }))).toBe("not_found");
    expect(await code(files.read(other, { path: join(bed.repo, "a.txt") }))).toBe("not_found");
    expect(await code(files.search(other, { root: bed.repo, query: "a" }))).toBe("not_found");
    const owner = testCaller();
    // A folder inside a root is not a root: the index is per root.
    mkdirSync(join(bed.repo, "src"));
    for (const root of [`${bed.repo}/`, join(bed.repo, "src"), bed.bb.base, "relative"])
      expect(await code(files.search(owner, { root, query: "a" })), root).toBe("not_found");
  });

  it("builds the scope from the transport's caller kind: a token is stricter than a session", async () => {
    const files = service({ u1: [bed.bb.home] });
    const session = testCaller();
    const token = testCaller({ kind: "token" });
    const ssh = join(bed.bb.home, ".ssh");
    expect((await files.list(session, { path: ssh })).entries.map((e) => e.name)).toEqual(["id"]);
    expect(await code(files.list(token, { path: ssh }))).toBe("not_found");
    expect(await code(files.read(token, { path: join(ssh, "id") }))).toBe("not_found");
    expect((await files.read(session, { path: join(ssh, "id") })).text).toBe("x");
  });

  it("leaves out of a token's search what only the owner may read", async () => {
    const proj = bed.bb.proj;
    const files = service({ u1: [proj] });
    const search = async (caller: ReturnType<typeof testCaller>) =>
      [...(await files.search(caller, { root: proj, query: "mcp" })).paths].sort();
    expect(await search(testCaller())).toEqual([".mcp.json", ".pi/mcp.json"]);
    expect(await search(testCaller({ kind: "token" }))).toEqual([]);
  });

  it("searches Pi's folder for a session without its private files, and refuses a token the root", async () => {
    const agent = bed.bb.agentDir;
    const files = service({ u1: [agent] });
    const search = (caller: ReturnType<typeof testCaller>, query: string) =>
      files.search(caller, { root: agent, query });
    expect(await search(testCaller(), "ext")).toEqual({ paths: ["extensions/e.ts"], truncated: false });
    expect(await search(testCaller(), "json")).toEqual({ paths: [], truncated: false });
    expect(await code(search(testCaller({ kind: "token" }), "ext"))).toBe("not_found");
  });
});

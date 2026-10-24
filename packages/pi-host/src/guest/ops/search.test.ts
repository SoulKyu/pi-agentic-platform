import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OpsBed, opsBed } from "./testing.ts";

let now = 0;
let bed: OpsBed;
beforeEach(() => {
  now = 1_000;
  bed = opsBed(() => now);
  mkdirSync(join(bed.project, "src"));
  writeFileSync(join(bed.project, "src", "main.ts"), "");
  writeFileSync(join(bed.project, "README.md"), "");
  writeFileSync(join(bed.project, "ignored.log"), "");
  writeFileSync(join(bed.project, ".gitignore"), "*.log\n");
});
afterEach(() => bed.clean());

const search = (query: string, limit = 10) => bed.value({ name: "fs.search", query, limit });

describe("fs.search", () => {
  it("ranks the project's files by git, paths relative to the root, ignored ones left out", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: bed.project, stdio: "pipe" });
    expect(await search("main")).toEqual({ paths: ["src/main.ts"], truncated: false });
    expect(await search("md", 1)).toEqual({ paths: ["README.md"], truncated: false });
    expect(((await search(".", 2)) as { truncated: boolean }).truncated).toBe(true);
    expect(await search("log")).toEqual({ paths: [], truncated: false });
  });

  it("falls back to ripgrep outside a repository, never listing .git", async () => {
    mkdirSync(join(bed.project, ".git"));
    writeFileSync(join(bed.project, ".git", "main.pack"), "");
    const found = (await search("main")) as { paths: string[] };
    expect(found.paths).toEqual(["src/main.ts"]);
  });

  it("keeps an index for 30 s on the guest's clock", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: bed.project, stdio: "pipe" });
    expect(await search("late")).toEqual({ paths: [], truncated: false });
    writeFileSync(join(bed.project, "late.txt"), "");
    expect(await search("late")).toEqual({ paths: [], truncated: false });
    now += 30_000;
    expect(await search("late")).toEqual({ paths: ["late.txt"], truncated: false });
  });
});

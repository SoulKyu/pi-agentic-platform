import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_LIMITS, type FileEntry, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { listFolder } from "./list.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const list = (
  path: string,
  options: { roots?: string[]; caller?: "session" | "token"; all?: boolean } = {},
) =>
  listFolder(
    bed.env(),
    bed.scope(options.roots ?? [bed.repo], options.caller ?? "session"),
    path,
    options.all === true,
  );
const names = (entries: readonly FileEntry[]) => entries.map((entry) => entry.name);
const code = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;

function ignoreAndTrack(): void {
  bed.file(join(bed.repo, ".gitignore"), "node_modules/\ndist/\n-foo/\n");
  bed.file(join(bed.repo, "node_modules", "pkg", "i.js"));
  bed.file(join(bed.repo, "dist", "keep.txt"));
  bed.file(join(bed.repo, "dist", "gen.js"));
  bed.file(join(bed.repo, "-foo", "kept.txt"));
  bed.gb.git(bed.repo, "add", ".gitignore");
  bed.gb.git(bed.repo, "add", "-f", "dist/keep.txt");
  bed.gb.git(bed.repo, "add", "-f", "--", "-foo/kept.txt");
  bed.gb.git(bed.repo, "commit", "-q", "-m", "more");
}

describe("order and the names that are never listed (M8R24)", () => {
  it("never lists the temporary file of an interrupted write, even with showIgnored (MC38 m9)", async () => {
    bed.file(join(bed.repo, "docs", ".pap-0123456789ab.tmp"));
    bed.file(join(bed.repo, "docs", ".pap-notours.tmp"));
    bed.file(join(bed.repo, "docs", "a.txt"));
    expect(names((await list(join(bed.repo, "docs"))).entries)).toEqual([".pap-notours.tmp", "a.txt"]);
    expect(names((await list(join(bed.repo, "docs"), { all: true })).entries)).toEqual([
      ".pap-notours.tmp",
      "a.txt",
    ]);
  });

  it("lists folders first, then the rest, each by lower-cased name and then by code point", async () => {
    for (const dir of ["Zeta", "alpha", "Beta"]) mkdirSync(join(bed.repo, "docs", dir), { recursive: true });
    for (const name of ["b.txt", "A.txt", "a.txt", "B.txt", "\u{1F600}.txt", "Ａ.txt"])
      bed.file(join(bed.repo, "docs", name));
    bed.file(join(bed.repo, "docs", ".DS_Store"));
    bed.file(join(bed.repo, "docs", ".git", "x"));
    const { entries, truncated } = await list(join(bed.repo, "docs"));
    expect(names(entries)).toEqual([
      "alpha",
      "Beta",
      "Zeta",
      "A.txt",
      "a.txt",
      "B.txt",
      "b.txt",
      "Ａ.txt",
      "\u{1F600}.txt",
    ]);
    expect(truncated).toBe(false);
    expect(entries[0]).toEqual({
      name: "alpha",
      kind: "dir",
      size: null,
      mtimeMs: expect.any(Number),
      hidden: null,
      protected: false,
      link: null,
      linkDir: false,
    });
    expect(entries[3]).toMatchObject({ name: "A.txt", kind: "file", size: 1 });
  });

  it("clamps a pre-1970 mtime to 0: the contract refuses a negative one (m3)", async () => {
    const old = bed.file(join(bed.repo, "old.txt"));
    utimesSync(old, new Date("1969-12-31"), new Date("1969-12-31"));
    const { entries } = await list(bed.repo);
    expect(entries.find((e) => e.name === "old.txt")?.mtimeMs).toBe(0);
  });

  it("never lists .git, and the root of a repository shows its files", async () => {
    const { entries } = await list(bed.repo);
    expect(names(entries)).toEqual(["-rf", "a\nb", "a.txt"]);
  });
});

describe("what git ignores (M8R24)", () => {
  it("leaves ignored names out, and returns them as ignored under showIgnored", async () => {
    ignoreAndTrack();
    bed.file(join(bed.repo, "plain.txt"));
    const shown = await list(bed.repo);
    expect(names(shown.entries)).not.toContain("node_modules");
    expect(names(shown.entries)).toContain("plain.txt");
    const all = await list(bed.repo, { all: true });
    expect(all.entries.find((e) => e.name === "node_modules")).toMatchObject({
      kind: "dir",
      hidden: "ignored",
    });
  });

  it("keeps a folder visible when it holds a tracked path, dash-led names included (m15)", async () => {
    ignoreAndTrack();
    const { entries } = await list(bed.repo);
    expect(entries.find((e) => e.name === "dist")).toMatchObject({ hidden: null });
    expect(entries.find((e) => e.name === "-foo")).toMatchObject({ hidden: null });
    expect(entries.find((e) => e.name === "node_modules")).toBeUndefined();
    // git answered for the whole listing (not the name list): the dash-led name went to ls-files as ./-foo
    const all = await list(bed.repo, { all: true });
    expect(all.entries.find((e) => e.name === "node_modules")?.hidden).toBe("ignored");
  });

  it("lists a folder that is itself ignored, with the name list standing in for git", async () => {
    bed.file(join(bed.repo, ".gitignore"), "build/\n");
    bed.file(join(bed.repo, "build", "sub", "f.txt"));
    bed.file(join(bed.repo, "build", "gen.js"));
    mkdirSync(join(bed.repo, "build", "node_modules"));
    const { entries } = await list(join(bed.repo, "build"), { all: true });
    expect(entries.map((e) => [e.name, e.hidden])).toEqual([
      ["node_modules", "excluded"],
      ["sub", null],
      ["gen.js", null],
    ]);
  });

  it("never reads a name like :(glob)x as pathspec magic", async () => {
    bed.file(join(bed.repo, ".gitignore"), "x\n");
    bed.file(join(bed.repo, "x"));
    bed.file(join(bed.repo, ":(glob)x"));
    bed.file(join(bed.repo, ":(glob)*"));
    const { entries } = await list(bed.repo);
    expect(names(entries)).toEqual(expect.arrayContaining([":(glob)x", ":(glob)*"]));
    expect(names(entries)).not.toContain("x");
  });

  it("lists a subfolder of the repository through the repository's own ignore rules", async () => {
    bed.file(join(bed.repo, ".gitignore"), "*.log\n");
    bed.file(join(bed.repo, "src", "a.log"));
    bed.file(join(bed.repo, "src", "a.ts"));
    expect(names((await list(join(bed.repo, "src"))).entries)).toEqual(["a.ts"]);
    expect(names((await list(join(bed.repo, "src"), { all: true })).entries)).toEqual(["a.log", "a.ts"]);
  });

  it("falls back to the name list when git fails or runs out of time", async () => {
    ignoreAndTrack();
    for (const kind of ["failed", "timeout"] as const) {
      const git: GitRunner = {
        run: () => Promise.reject(new GitError(kind)),
      };
      const scope = bed.scope([bed.repo]);
      const { entries } = await listFolder(bed.env({ git }), scope, bed.repo, true);
      expect(entries.find((e) => e.name === "node_modules")).toMatchObject({ hidden: "excluded" });
      expect(entries.find((e) => e.name === "dist")).toMatchObject({ hidden: "excluded" });
      expect(entries.find((e) => e.name === ".gitignore")).toMatchObject({ hidden: null });
    }
  });

  it("asks git with a 5 s deadline and fixed names", async () => {
    const calls: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = [];
    const git: GitRunner = {
      run: (_root, args, options) => {
        calls.push({ args, timeoutMs: options?.timeoutMs });
        return Promise.resolve({ stdout: Buffer.alloc(0), code: 1 });
      },
    };
    await listFolder(bed.env({ git }), bed.scope([bed.repo]), bed.repo, false);
    expect(calls).toEqual([{ args: ["check-ignore", "-z", "--stdin", "--no-index"], timeoutMs: 5000 }]);
  });

  it("outside a work tree the fixed list gives excluded", async () => {
    const plain = join(bed.bb.base, "plain");
    for (const name of [
      "node_modules",
      "dist",
      "build",
      "out",
      "target",
      "coverage",
      ".next",
      ".nuxt",
      ".venv",
    ])
      mkdirSync(join(plain, name), { recursive: true });
    for (const name of ["venv", "__pycache__", ".cache", ".turbo", ".parcel-cache", "src"])
      mkdirSync(join(plain, name));
    const shown = await list(plain, { roots: [plain] });
    expect(names(shown.entries)).toEqual(["src"]);
    const all = await list(plain, { roots: [plain], all: true });
    expect(all.entries.filter((e) => e.hidden === "excluded")).toHaveLength(14);
    expect(all.entries.find((e) => e.name === "src")?.hidden).toBeNull();
  });
});

describe("links, pipes and protected entries (M8R25)", () => {
  it("resolves a link and judges its target against the caller's roots", async () => {
    bed.file(join(bed.repo, "real", "f.txt"));
    bed.link(join(bed.repo, "real"), join(bed.repo, "in-dir"));
    bed.link(join(bed.repo, "a.txt"), join(bed.repo, "in-file"));
    bed.link(bed.bb.outside, join(bed.repo, "out"));
    bed.link(join(bed.bb.base, "nowhere"), join(bed.repo, "broken"));
    bed.link("loop", join(bed.repo, "loop"));
    bed.fifo(join(bed.repo, "pipe"));
    const { entries } = await list(bed.repo);
    const by = (name: string) => entries.find((e) => e.name === name);
    expect(by("in-dir")).toMatchObject({ kind: "link", link: "inside", linkDir: true, protected: false });
    expect(by("in-file")).toMatchObject({ kind: "link", link: "inside", linkDir: false });
    expect(by("out")).toMatchObject({ kind: "link", link: "outside", linkDir: true });
    expect(by("broken")).toMatchObject({ kind: "link", link: "broken", linkDir: false });
    expect(by("loop")).toMatchObject({ kind: "link", link: "broken" });
    expect(by("pipe")).toMatchObject({ kind: "other", size: null, link: null });
    // A link to a folder sorts with the folders.
    expect(names(entries).indexOf("in-dir")).toBeLessThan(names(entries).indexOf("a.txt"));
  });

  it("marks pap's home and a link into it as protected, for every caller", async () => {
    const config = bed.bb.config({ papHome: [join(bed.repo, ".pap")] });
    bed.file(join(bed.repo, ".pap", "state.db"));
    bed.link(join(bed.repo, ".pap"), join(bed.repo, "via"));
    for (const caller of ["session", "token"] as const) {
      const scope = bed.scope([bed.repo], caller, config);
      const { entries } = await listFolder(bed.env(), scope, bed.repo, false);
      expect(entries.find((e) => e.name === ".pap")?.protected, caller).toBe(true);
      expect(entries.find((e) => e.name === "via")?.protected, caller).toBe(true);
      expect(entries.find((e) => e.name === "a.txt")?.protected, caller).toBe(false);
    }
    const scope = bed.scope([bed.repo], "session", config);
    expect(await code(listFolder(bed.env(), scope, join(bed.repo, ".pap"), false))).toBe("not_found");
  });

  it("a browser session lists home's .ssh as ordinary; a token sees it protected and cannot open it", async () => {
    const roots = [bed.bb.home];
    const home = bed.bb.home;
    const session = await list(home, { roots });
    expect(session.entries.find((e) => e.name === ".ssh")).toMatchObject({ kind: "dir", protected: false });
    const token = await list(home, { roots, caller: "token" });
    expect(token.entries.find((e) => e.name === ".ssh")?.protected).toBe(true);
    expect(await code(list(join(home, ".ssh"), { roots, caller: "token" }))).toBe("not_found");
    expect((await list(join(home, ".ssh"), { roots })).entries.map((e) => e.name)).toEqual(["id"]);
  });

  it("shows a token the agent directory and .pi/mcp.json as protected entries", async () => {
    const pi = join(bed.bb.home, ".pi");
    const token = await list(pi, { roots: [pi], caller: "token" });
    expect(token.entries.find((e) => e.name === "agent")?.protected).toBe(true);
    const proj = await list(join(bed.bb.proj, ".pi"), { roots: [bed.bb.proj], caller: "token" });
    expect(proj.entries.find((e) => e.name === "mcp.json")?.protected).toBe(true);
    expect(proj.entries.find((e) => e.name === "settings.json")?.protected).toBe(false);
  });
});

describe("bounds and refusals", () => {
  it("answers at most 5 000 entries and says so", async () => {
    const big = join(bed.bb.base, "big");
    mkdirSync(big);
    for (let i = 0; i < FILE_LIMITS.listEntries + 1; i++) writeFileSync(join(big, `f${i}`), "");
    const { entries, truncated } = await list(big, { roots: [big] });
    expect(entries).toHaveLength(5000);
    expect(truncated).toBe(true);
  });

  it("reads at most the scan limit of names from one folder and says so", async () => {
    const many = join(bed.bb.base, "many");
    mkdirSync(many);
    for (let i = 0; i < 12; i++) writeFileSync(join(many, `f${i}`), "");
    const scope = bed.scope([many]);
    const cut = await listFolder(bed.env(), scope, many, false, 10);
    expect(cut.entries).toHaveLength(10);
    expect(cut.truncated).toBe(true);
    const whole = await listFolder(bed.env(), scope, many, false, 12);
    expect(whole.entries).toHaveLength(12);
    expect(whole.truncated).toBe(false);
  });

  it("fits the answer under the page size by dropping the tail", async () => {
    const wide = join(bed.bb.base, "wide");
    mkdirSync(wide);
    for (let i = 0; i < 3000; i++)
      writeFileSync(join(wide, `${String(i).padStart(4, "0")}${"n".repeat(240)}`), "");
    const { entries, truncated } = await list(wide, { roots: [wide] });
    expect(truncated).toBe(true);
    expect(entries.length).toBeLessThan(3000);
    expect(sizeOf({ entries, truncated })).toBeLessThanOrEqual(PAGE_BYTES);
    expect(entries[0]?.name.startsWith("0000")).toBe(true);
  });

  it("answers not_found for a path outside the roots, a missing one, a file, a relative one and an escape", async () => {
    for (const path of [
      bed.bb.outside,
      join(bed.repo, "missing"),
      join(bed.repo, "a.txt"),
      "relative",
      `${bed.repo}/../outside`,
    ]) {
      expect(await code(list(path)), path).toBe("not_found");
    }
    bed.link(bed.bb.outside, join(bed.repo, "out"));
    expect(await code(list(join(bed.repo, "out")))).toBe("not_found");
  });
});

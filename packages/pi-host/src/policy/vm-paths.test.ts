import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeVmWorld } from "../testing/vm-world.ts";
import { judgeVmPath, realVmRoots, vmFileFolders, type VmFileRoots } from "./vm-paths.ts";

// RT-01 mutants, each run for real and killed by the cases named here (RT-43):
//  - M1 the judge without the rewrite refusal (`REWRITTEN`/`UNICODE_SPACE` line removed): "refuses what Pi would rewrite"
//    (the `@`, `~`, `file:` and U+00A0 cases expect `rewritten path`; a NBSP name inside home would be judged as itself).
//  - M2 the judge without the leaf `link` refusal: "refuses a link as `link`" (dangling and live links).
//  - M3a the judge without `realOrNearest`: killed by `a/../dl/sessions/s.jsonl` (kernelResolve appends what follows the
//    first missing component lexically, so only the real-path check sees through `a/..` then the folder link).
//  - M3b the judge without `kernelResolve`: killed by `dl/../new.txt` (`..` applied to the link's target).
//  - M4 a write allowed under the read-only roots: "a write under the read-only roots is outside".

let world: ReturnType<typeof makeVmWorld>;
let roots: VmFileRoots;
let home: string;
const NBSP = String.fromCharCode(0xa0);
const verdict = (raw: unknown, write = false, cwd = home) => judgeVmPath(raw, cwd, roots, write);
const refused = (reason: string) => ({ ok: false, reason });

beforeEach(async () => {
  world = makeVmWorld();
  home = world.layout.home;
  roots = await realVmRoots(world.layout);
  writeFileSync(join(home, "z.txt"), "z");
  symlinkSync(".pi/sessions/new.jsonl", join(home, "x")); // dangling
  symlinkSync("z.txt", join(home, "y")); // live, inside home
  symlinkSync(world.layout.pi, join(home, "dl"));
});
afterEach(() => world.cleanup());

describe("judgeVmPath: what Pi would rewrite", () => {
  it("refuses what Pi would rewrite, read and write", async () => {
    const { root } = world.layout;
    for (const [raw, write] of [
      [`@${root}/.pi/sessions/s.jsonl`, true],
      [`@${join(home, "z.txt")}`, false],
      ["~/../agent/.pi/sessions/s.jsonl", true],
      ["~/../proc/self/environ", false],
      ["~", false],
      [`file://${root}/.pi/sessions/s.jsonl`, false],
      [`file:${join(home, "z.txt")}`, false],
      [`a${NBSP}b.txt`, true],
      [`a${String.fromCharCode(0x2009)}b.txt`, false],
      [`a${String.fromCharCode(0x3000)}b.txt`, true],
    ] as const)
      expect(await verdict(raw, write), `${raw} ${write}`).toEqual(refused("rewritten path"));
  });

  it("refuses an unreadable path", async () => {
    for (const raw of [undefined, null, 3, "", "a\0b", "a/".repeat(3000)])
      expect(await verdict(raw)).toEqual(refused("unreadable path"));
  });
});

describe("judgeVmPath: links and folders", () => {
  it("refuses a link as `link`, dangling or not, for read and write", async () => {
    for (const write of [false, true]) {
      expect(await verdict("x", write)).toEqual(refused("link"));
      expect(await verdict("y", write)).toEqual(refused("link"));
      expect(await verdict(join(home, "x"), write)).toEqual(refused("link"));
    }
  });

  it("a folder link is outside: `dl/sessions/s.jsonl` through `home/dl -> .pi`", async () => {
    expect(await verdict("dl/sessions/s.jsonl")).toEqual(refused("outside this agent's folders"));
    expect(await verdict("dl/sessions/s.jsonl", true)).toEqual(refused("outside this agent's folders"));
    expect(await verdict("dl/sessions/new.jsonl", true)).toEqual(refused("outside this agent's folders"));
    // A missing first component, then `..` into the link: only the real-path check sees where it lands.
    expect(await verdict("a/../dl/sessions/s.jsonl")).toEqual(refused("outside this agent's folders"));
    expect(await verdict("a/../dl/sessions", false)).toEqual(refused("outside this agent's folders"));
  });

  it("judges `..` after a folder link the way the kernel resolves it: `dl/../new.txt` leaves home", async () => {
    // Lexically `home/new.txt`; the kernel applies `..` to the link's target (`.pi`), which is `agent/new.txt`.
    expect(await verdict("dl/../new.txt", true)).toEqual(refused("outside this agent's folders"));
  });

  it("refuses a path outside the agent's folders", async () => {
    const outside = refused("outside this agent's folders");
    for (const raw of ["../.pi/sessions/s.jsonl", "/proc/self/environ", world.transcript, "..", "/"])
      for (const write of [false, true]) expect(await verdict(raw, write), raw).toEqual(outside);
  });

  it("a read names an existing path: a missing one is `missing`", async () => {
    expect(await verdict("nope.txt")).toEqual(refused("missing"));
    expect(await verdict("a/b/c.txt")).toEqual(refused("missing"));
  });

  it("a write under the read-only roots is outside, a read is allowed", async () => {
    const skill = join(world.layout.piAgentDir, "skills", "k.md");
    expect(await verdict(skill, true)).toEqual(refused("outside this agent's folders"));
    expect(await verdict(join(world.layout.piAgentDir, "skills", "new.md"), true)).toEqual(
      refused("outside this agent's folders"),
    );
    expect(await verdict(skill)).toEqual({ ok: true });
    expect(await verdict(join(world.layout.piAgentDir, "skills"))).toEqual({ ok: true });
    // Pi's agent folder itself (settings, auth) is not a read-only root.
    expect(await verdict(join(world.layout.piAgentDir, "settings.json"))).toEqual(
      refused("outside this agent's folders"),
    );
  });

  it("a write to a folder is `not a file`", async () => {
    mkdirSync(join(home, "sub"));
    expect(await verdict("sub", true)).toEqual(refused("not a file"));
    expect(await verdict(home, true)).toEqual(refused("not a file"));
  });

  it("allows a new file whose parents do not exist yet, an existing file, a folder for `ls`", async () => {
    expect(await verdict("a/b/c.txt", true)).toEqual({ ok: true });
    expect(await verdict(join(world.layout.knowledge, "n", "k.md"), true)).toEqual({ ok: true });
    expect(await verdict(join(world.layout.inbox, "f.bin"), true)).toEqual({ ok: true });
    expect(await verdict("z.txt")).toEqual({ ok: true });
    expect(await verdict("z.txt", true)).toEqual({ ok: true });
    expect(await verdict(".")).toEqual({ ok: true });
    expect(await verdict(home)).toEqual({ ok: true });
  });
});

describe("realVmRoots", () => {
  it("returns real paths: writable first, the read-only ones that exist", async () => {
    expect(roots.writable).toEqual([home, world.layout.knowledge, world.layout.inbox]);
    expect(roots.readOnly).toEqual([join(world.layout.piAgentDir, "skills")]);
    expect(vmFileFolders(world.layout).readOnly).toEqual(
      ["skills", "npm", "git", "local"].map((name) => join(world.layout.piAgentDir, name)),
    );
  });

  it("refuses a writable root that is a link, or not a folder, or missing", async () => {
    const fresh = makeVmWorld();
    try {
      const other = join(fresh.base, "elsewhere");
      mkdirSync(other);
      const { rmSync } = await import("node:fs");
      rmSync(fresh.layout.inbox, { recursive: true });
      symlinkSync(other, fresh.layout.inbox);
      await expect(realVmRoots(fresh.layout)).rejects.toThrow("not a real folder");
      rmSync(fresh.layout.inbox);
      writeFileSync(fresh.layout.inbox, "file");
      await expect(realVmRoots(fresh.layout)).rejects.toThrow("not a real folder");
      rmSync(fresh.layout.inbox);
      await expect(realVmRoots(fresh.layout)).rejects.toThrow();
    } finally {
      fresh.cleanup();
    }
  });

  it("refuses a read-only root that is a link, and drops a missing one", async () => {
    const fresh = makeVmWorld();
    try {
      const { rmSync } = await import("node:fs");
      const skills = join(fresh.layout.piAgentDir, "skills");
      rmSync(skills, { recursive: true });
      expect((await realVmRoots(fresh.layout)).readOnly).toEqual([]);
      symlinkSync(fresh.layout.sessions, skills);
      await expect(realVmRoots(fresh.layout)).rejects.toThrow("not a real folder");
    } finally {
      fresh.cleanup();
    }
  });

  it("an unreadable parent is an error, not a missing root", async () => {
    const fresh = makeVmWorld();
    try {
      chmodSync(fresh.layout.pi, 0o000);
      await expect(realVmRoots(fresh.layout)).rejects.toThrow();
    } finally {
      chmodSync(fresh.layout.pi, 0o755);
      fresh.cleanup();
    }
  });
});

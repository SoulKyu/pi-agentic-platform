import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeVmWorld } from "../testing/vm-world.ts";
import { judgeVmPath, realVmRoots, vmFileFolders, type VmFileRoots } from "./vm-paths.ts";

// RT-01 mutants, each run for real and killed by the cases named here (RT-43):
//  - M1 the judge without the rewrite refusal (`REWRITTEN`/`UNICODE_SPACE` line removed): "refuses what Pi would rewrite"
//    (the `@`, `~`, `file:` and U+00A0 cases expect `rewritten path`; a NBSP name inside home would be judged as itself).
//  - M2 the judge without the leaf `link` refusal: "refuses a link as `link`" (dangling and live links).
//  - M3a the judge without the lexical walk (`kernelResolve(cwd, lexical, reachable)`): killed by `a/../dl/sessions/s.jsonl` (the kernel reading appends what follows the
//    first missing component lexically, so only the real-path check sees through `a/..` then the folder link).
//  - M3b the judge without `kernelResolve`: killed by `dl/../new.txt` (`..` applied to the link's target).
//  - M5 (S1 item 1) the leaf verdicts (`link`, `missing`, `not a file`) back before the real-path checks: "a planted link to /
//    gives no existence or type oracle" (an existing file, a missing one, a folder and an unreadable one all answer `outside`).
//  - M6 (S1 round 1, I1) the kernel walk not bounded to the layout (`reachable` dropped): "no probe through a link walked outside
//    tells a live pid, a dead pid or a planted link target apart" (`r/proc/<pid>/exe/../..` answers ok or outside by the pid).
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

  it("a planted link to / is no existence or type oracle: every probe outside the layout answers the same", async () => {
    symlinkSync("/", join(home, "r"));
    const outside = refused("outside this agent's folders");
    for (const raw of [
      "r/etc/hostname",
      "r/etc/pap-no-such-file",
      "r/etc",
      "r/proc/1/environ",
      "r/root/x/y",
      "r/tmp",
    ])
      for (const write of [false, true])
        expect(await verdict(raw, write), `${raw} ${write}`).toEqual(outside);
  });

  it("no probe through a link walked outside tells a live pid, a dead pid or a planted link target apart (I1)", async () => {
    symlinkSync("/", join(home, "r"));
    const outside = refused("outside this agent's folders");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const target = join(home, "z.txt");
    for (const pid of [process.pid, dead, 4_194_303])
      for (let ups = 1; ups <= 5; ups += 1) {
        const raw = `r/proc/${pid}/exe${"/..".repeat(ups)}${target}`;
        for (const write of [false, true])
          expect(await verdict(raw, write), `${raw} ${write}`).toEqual(outside);
      }
    // A link whose target walks through `<outside>/lnk/..` lands on a layout file whatever `lnk` is, yet is outside.
    const out = join(world.base, "out");
    mkdirSync(out);
    const via = `${out}/lnk/../${relative(out, target)}`;
    for (const make of [
      () => {},
      () => mkdirSync(join(out, "lnk")),
      () => writeFileSync(join(out, "lnk"), "f"),
      () => symlinkSync(out, join(out, "lnk")),
    ]) {
      rmSync(join(out, "lnk"), { recursive: true, force: true });
      make();
      rmSync(join(home, "w"), { force: true });
      symlinkSync(via, join(home, "w"));
      for (const write of [false, true]) expect(await verdict("w", write)).toEqual(outside);
    }
  });

  // S1 round 2 (I1 remainder; AVM-E60 m1/m2). Mutant: the lexical reading back to an unbounded `realpath` walk
  // (`kernelResolve(cwd, lexical)` without `reachable`) -> a live pid answers ok, a dead one outside. `cwd/z.txt` shows it
  // only for a pid whose cwd is the home (a spawned child), `root<home>/z.txt` for any live pid. Heads: `m` does not exist
  // (the first spelling of AVM-E59), `x` and `L` dangle.
  it("a missing component or a dangling link before `..` does not let the rest be resolved outside", async () => {
    symlinkSync("/", join(home, "r"));
    symlinkSync("nowhere/x", join(home, "L"));
    const outside = refused("outside this agent's folders");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      cwd: home,
      stdio: "ignore",
    });
    try {
      for (const pid of [child.pid, process.pid, dead, 4_194_303])
        for (const head of ["m", "x", "L"])
          for (const tail of [`root${join(home, "z.txt")}`, "cwd/z.txt"]) {
            const raw = `${head}/../r/proc/${pid}/${tail}`;
            for (const write of [false, true])
              expect(await verdict(raw, write), `${raw} ${write}`).toEqual(outside);
          }
    } finally {
      child.kill();
    }
  });

  it("still allows a link inside the home to elsewhere in the home, `..` back into it, and `..` into the skills folder", async () => {
    mkdirSync(join(home, "sub"));
    writeFileSync(join(home, "sub", "f.txt"), "f");
    symlinkSync(join(home, "sub"), join(home, "in"));
    symlinkSync("sub", join(home, "in2"));
    for (const raw of [
      "in/f.txt",
      "in2/f.txt",
      "sub/../z.txt",
      "in/../z.txt",
      "in2/../z.txt",
      join(home, "z.txt"),
    ])
      for (const write of [false, true])
        expect(await verdict(raw, write), `${raw} ${write}`).toEqual({ ok: true });
    expect(await verdict("../.pi/agent/skills/k.md")).toEqual({ ok: true });
    expect(await verdict("../.pi/agent/skills/k.md", true)).toEqual(refused("outside this agent's folders"));
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

describe("a project layout", () => {
  it("a project layout writes project, home and inbox and refuses .pi", async () => {
    const box = makeVmWorld({ project: true });
    try {
      const { layout } = box;
      const project = layout.project as string;
      expect(vmFileFolders(layout).writable).toEqual([project, layout.home, layout.inbox]);
      const boxRoots = await realVmRoots(layout);
      for (const target of [project, layout.home, layout.inbox, `${project}/knowledge/index.md`])
        expect(await judgeVmPath(`${target}/new.txt`, project, boxRoots, true), target).toEqual({ ok: true });
      expect(await judgeVmPath(box.transcript, project, boxRoots, false)).toEqual(
        refused("outside this agent's folders"),
      );
      expect(await judgeVmPath(`${layout.pi}/x`, project, boxRoots, true)).toEqual(
        refused("outside this agent's folders"),
      );
    } finally {
      box.cleanup();
    }
  });
});

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createDenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { createBoundaryBed } from "../../kernel/testing/boundary-bed.ts";
import { applyCopyLink } from "./copy-link.ts";

/** The bed's home is the project root, as M8R98 allows: it holds `.ssh/id`, `.pap/state.db` and `.pi/agent/auth.json`. */
let bb: ReturnType<typeof createBoundaryBed>;
let lane: string;
let log: string[];

/** Everything is ignored: only the boundary and the deny set may refuse here. */
const git: GitRunner = {
  async run(_cwd, _args, options) {
    return { stdout: options?.input ?? Buffer.alloc(0), code: 0 };
  },
};

const denyFolders = (): string[] => [
  join(bb.home, ".ssh"),
  join(bb.home, ".config", "gh"),
  bb.papHome,
  join(bb.agentDir, "sessions"),
];

const input = (over: { copy?: string[]; link?: string[] }) => ({
  root: bb.home,
  worktree: lane,
  gitDir: "/x/.git/worktrees/lane",
  copy: over.copy ?? [],
  link: over.link ?? [],
  git,
  boundary: bb.config(),
  deny: createDenySet(
    { files: [], folders: denyFolders(), skip: [] },
    createFakeClock(Date.now() + 3_600_000),
  ),
  denyFolders: denyFolders(),
  log: (line: string) => log.push(line),
  diskFloor: async () => {},
});

const run = (over: { copy?: string[]; link?: string[] }) => applyCopyLink(input(over));

beforeEach(() => {
  bb = createBoundaryBed();
  lane = realpathSync(mkdtempSync(join(tmpdir(), "pap-lane-")));
  log = [];
});
afterEach(() => {
  bb.dispose();
  rmSync(lane, { recursive: true, force: true });
});

describe("copy and link never hand over what M8 refuses", () => {
  it("leaves ~/.ssh/id out of a copied folder", async () => {
    const result = await run({ copy: [".ssh"] });
    expect(existsSync(join(lane, ".ssh", "id"))).toBe(false);
    expect(result.skipped).toBe(1);
    expect(log[0]).toContain("denied");
  });

  it("refuses a hard link to a private file, which is the same inode under another name", async () => {
    linkSync(join(bb.home, ".ssh", "id"), join(bb.home, ".env"));
    expect((await run({ copy: [".env"] })).skipped).toBe(1);
    expect(existsSync(join(lane, ".env"))).toBe(false);
    expect(log[0]).toContain("denied");
  });

  it("refuses $PAP_HOME and Pi's private files by the path judge", async () => {
    const result = await run({ copy: [".pap/state.db", ".pi/agent/auth.json"], link: [".pap"] });
    expect(result.skipped).toBe(3);
    expect(existsSync(join(lane, ".pap"))).toBe(false);
    expect(existsSync(join(lane, ".pi"))).toBe(false);
  });

  it("refuses to link a folder that holds a private file, or one above $PAP_HOME", async () => {
    writeFileSync(join(bb.home, "top.txt"), "x");
    mkdirSync(join(bb.home, "wrap"));
    const result = await run({ link: [".ssh", ".pi"] });
    expect(result.skipped).toBe(2);
    expect(existsSync(join(lane, ".ssh"))).toBe(false);
    expect(existsSync(join(lane, ".pi"))).toBe(false);
  });

  it("refuses to link a folder above a denied one, with a separator-aware comparison", async () => {
    bb.file(join(bb.home, ".config", "gh", "hosts.yml"), "token");
    bb.file(join(bb.home, ".configX", "notes.txt"), "fine");
    bb.file(join(bb.home, ".config", "other", "a.txt"), "fine");
    const result = await run({ link: [".config", ".configX", ".config/other"] });
    expect(result.skipped).toBe(1);
    expect(log[0]).toContain('".config"');
    expect(log[0]).toContain("denied");
    // `.config` itself is no link: it exists only as the parent of the allowed `.config/other` link.
    expect(lstatSync(join(lane, ".config")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(lane, ".config", "gh"))).toBe(false);
    expect(readlinkSync(join(lane, ".configX"))).toBe(join(bb.home, ".configX"));
    expect(readlinkSync(join(lane, ".config", "other"))).toBe(join(bb.home, ".config", "other"));
  });

  it("fails the preparation when a copy the lane does not ignore cannot be removed", async () => {
    bb.file(join(bb.home, "cfg", "sub", "a.txt"), "x");
    const readOnly = join(bb.home, "cfg", "sub");
    chmodSync(readOnly, 0o555);
    const laneIgnores: GitRunner = {
      async run(cwd, _args, options) {
        // The owner's checkout ignores everything; the lane ignores nothing.
        return cwd === bb.home
          ? { stdout: options?.input ?? Buffer.alloc(0), code: 0 }
          : { stdout: Buffer.alloc(0), code: 1 };
      },
    };
    try {
      await expect(
        applyCopyLink({ ...input({ copy: ["cfg"], link: [".configX"] }), git: laneIgnores }),
      ).rejects.toThrow("could not remove a copy");
      expect(existsSync(join(lane, "cfg", "sub", "a.txt"))).toBe(true);
      expect(existsSync(join(lane, ".configX"))).toBe(false);
    } finally {
      chmodSync(readOnly, 0o755);
      chmodSync(join(lane, "cfg", "sub"), 0o755);
    }
  });
});

describe("copy and link hardening (sweep A6)", () => {
  it("copies a folder without a nested repository's .git, counted as one skip", async () => {
    bb.file(join(bb.home, "vendor", "lib", "a.txt"), "a");
    bb.file(join(bb.home, "vendor", "lib", ".git", "config"), "[core]");
    const result = await run({ copy: ["vendor"] });
    expect(existsSync(join(lane, "vendor", "lib", "a.txt"))).toBe(true);
    expect(existsSync(join(lane, "vendor", "lib", ".git"))).toBe(false);
    expect(result.skipped).toBe(1);
    expect(log[0]).toContain("git");
  });

  it("refuses to link a folder that holds a .git entry", async () => {
    bb.file(join(bb.home, "vendor", ".git", "config"), "[core]");
    const result = await run({ link: ["vendor"] });
    expect(result.skipped).toBe(1);
    expect(existsSync(join(lane, "vendor"))).toBe(false);
  });

  it("refuses to link a folder listing past the probe cap instead of probing part of it", async () => {
    const big = join(bb.home, "big");
    mkdirSync(big);
    for (let i = 0; i <= 10_000; i += 1) writeFileSync(join(big, `f${i}`), "");
    const result = await run({ link: ["big"] });
    expect(result.skipped).toBe(1);
    expect(existsSync(join(lane, "big"))).toBe(false);
  });

  it("compares denied folders by their real path, so a symlinked spelling still refuses", async () => {
    bb.file(join(bb.home, ".config", "gh", "hosts.yml"), "token");
    const alias = join(lane, "..", `pap-alias-${process.pid}`);
    symlinkSync(bb.home, alias);
    try {
      const viaAlias = { ...input({ link: [".config"] }), denyFolders: [join(alias, ".config", "gh")] };
      const result = await applyCopyLink(viaAlias);
      expect(result.skipped).toBe(1);
      expect(log[0]).toContain("denied");
      expect(existsSync(join(lane, ".config"))).toBe(false);
    } finally {
      rmSync(alias, { force: true });
    }
  });
});

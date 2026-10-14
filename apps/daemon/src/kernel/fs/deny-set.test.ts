import { chmodSync, linkSync, mkdirSync, symlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createBoundaryBed } from "../testing/boundary-bed.ts";
import { createDenySet, type DenySources } from "./deny-set.ts";

let bed: ReturnType<typeof createBoundaryBed>;
beforeEach(() => {
  bed = createBoundaryBed();
  bed.file(join(bed.papHome, "secrets", "k"));
  bed.file(join(bed.papHome, "backups", "b.db"));
  bed.file(join(bed.papHome, "search.db"));
});
afterEach(() => bed.dispose());

const HOUR = 3_600_000;
// A clock far ahead of every file: nothing in the bed counts as changed since a walk.
const later = () => createFakeClock(Date.now() + HOUR);
// A clock far behind: every file counts as changed after the first walk started.
const earlier = () => createFakeClock(Date.now() - HOUR);
const st = (path: string) => stat(path, { bigint: true });

describe("the deny set", () => {
  it("knows pap's and Pi's private inodes, all of $PAP_HOME included", async () => {
    const deny = createDenySet(bed.denySources(), later());
    const known = [
      join(bed.agentDir, "auth.json"),
      join(bed.agentDir, "models.json"),
      join(bed.papHome, "state.db"),
      join(bed.papHome, "search.db"),
      join(bed.papHome, "secrets", "k"),
      join(bed.papHome, "backups", "b.db"),
      join(bed.agentDir, "sessions", "x", "a.jsonl"),
    ];
    for (const path of known) expect(await deny.has(await st(path)), path).toBe(true);
    expect(await deny.has(await st(join(bed.proj, "a.txt")))).toBe(false);
  });

  it("leaves out what the caller skips", async () => {
    bed.file(join(bed.papHome, "worktrees", "x", "f.txt"));
    const open = join(bed.papHome, "worktrees", "x", "f.txt");
    expect(await createDenySet(bed.denySources(), later()).has(await st(open))).toBe(true);
    const skipped = createDenySet(bed.denySources([join(bed.papHome, "worktrees")]), later());
    expect(await skipped.has(await st(open))).toBe(false);
    expect(await skipped.has(await st(join(bed.papHome, "state.db")))).toBe(true);
  });

  it("denies the target of a linked models.json", async () => {
    bed.file(join(bed.home, "dotfiles", "models.json"));
    const target = join(bed.agentDir, "models.json");
    rmSync(target);
    bed.link(join(bed.home, "dotfiles", "models.json"), target);
    const deny = createDenySet(bed.denySources(), later());
    expect(await deny.has(await st(join(bed.home, "dotfiles", "models.json")))).toBe(true);
  });

  it("catches a session file created after the first walk and linked at once", async () => {
    const clock = earlier();
    const deny = createDenySet(bed.denySources(), clock);
    expect(await deny.has(await st(join(bed.proj, "a.txt")))).toBe(false);
    const fresh = join(bed.agentDir, "sessions", "x", "fresh.jsonl");
    bed.file(fresh);
    const alias = join(bed.proj, "alias.txt");
    linkSync(fresh, alias);
    await clock.advance(2 * HOUR);
    expect(await deny.has(await st(alias))).toBe(true);
  });

  it("serves an ordinary file linked after the first walk, once a refresh covered it", async () => {
    const clock = earlier();
    const deny = createDenySet(bed.denySources(), clock);
    expect(await deny.has(await st(join(bed.proj, "a.txt")))).toBe(false);
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    await clock.advance(2 * HOUR);
    expect(await deny.has(await st(alias))).toBe(false);
  });

  it("serves an ordinary file with two names", async () => {
    const deny = createDenySet(bed.denySources(), later());
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    expect(await deny.has(await st(alias))).toBe(false);
  });

  it("remembers a private inode after its file was replaced and a walk ran again", async () => {
    const clock = earlier();
    const deny = createDenySet(bed.denySources(), clock);
    const auth = join(bed.agentDir, "auth.json");
    const alias = join(bed.proj, "alias.txt");
    linkSync(auth, alias);
    expect(await deny.has(await st(alias))).toBe(true);
    writeFileSync(`${auth}.new`, "NEW");
    renameSync(`${auth}.new`, auth);
    // a new link changes a ctime after the first walk: the next check walks again
    const other = join(bed.proj, "other.txt");
    linkSync(join(bed.proj, "a.txt"), other);
    await clock.advance(2 * HOUR);
    expect(await deny.has(await st(other))).toBe(false);
    expect(await deny.has(await st(alias))).toBe(true);
  });

  it("does not take a one-link file for a private one", async () => {
    const deny = createDenySet(bed.denySources(), later());
    expect(await deny.has(await st(join(bed.proj, "src", "a.ts")))).toBe(false);
  });

  it("fails closed on a linked unknown file once the walk was cut, and not on a one-link file", async () => {
    for (let i = 0; i < 12; i++) bed.file(join(bed.papHome, "secrets", `f${i}`));
    const deny = createDenySet(bed.denySources(), later(), 10);
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    expect(await deny.has(await st(alias))).toBe(true);
    expect(await deny.has(await st(join(bed.proj, "src", "a.ts")))).toBe(false);
  });

  it("fails closed on a linked unknown file once the set of remembered keys is full", async () => {
    const deny = createDenySet(bed.denySources(), later(), 1000, 3);
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    expect(await deny.has(await st(alias))).toBe(true);
    expect(await deny.has(await st(join(bed.proj, "src", "a.ts")))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("fails closed when a private folder cannot be read", async () => {
    const alias = join(bed.proj, "bk.txt");
    linkSync(join(bed.papHome, "backups", "b.db"), alias);
    chmodSync(join(bed.papHome, "backups"), 0o000);
    try {
      expect(await createDenySet(bed.denySources(), later()).has(await st(alias))).toBe(true);
    } finally {
      chmodSync(join(bed.papHome, "backups"), 0o755);
    }
  });

  it("runs one walk for two concurrent checks", async () => {
    const clock = later();
    let reads = 0;
    const counting = { ...clock, now: () => (reads++, clock.now()) };
    const deny = createDenySet(bed.denySources(), counting);
    const stat1 = await st(join(bed.proj, "a.txt"));
    await Promise.all([deny.has(stat1), deny.has(stat1)]);
    expect(reads).toBe(1);
  });

  describe("symlinks inside $PAP_HOME", () => {
    const walkOnly = (): DenySources => ({ files: [], folders: [bed.papHome], skip: [] });
    const target = (name: string) => join(bed.home, "elsewhere", name);

    it("follows a symlinked backups, secrets or exports folder and a symlinked state.db", async () => {
      for (const name of ["backups", "secrets", "exports"]) {
        rmSync(join(bed.papHome, name), { recursive: true, force: true });
        bed.file(join(target(name), "f"), "BACKUP-SECRET");
        symlinkSync(target(name), join(bed.papHome, name));
      }
      bed.file(target("real.db"), "DB-SECRET");
      rmSync(join(bed.papHome, "state.db"));
      symlinkSync(target("real.db"), join(bed.papHome, "state.db"));
      const deny = createDenySet(walkOnly(), later());
      for (const path of [
        target("backups") + "/f",
        target("secrets") + "/f",
        target("exports") + "/f",
        target("real.db"),
      ])
        expect(await deny.has(await st(path)), path).toBe(true);
      expect(await deny.has(await st(join(bed.proj, "src", "a.ts")))).toBe(false);
    });

    it("covers the named entries even when the walk of $PAP_HOME is not given", async () => {
      bed.file(target("real.db"), "DB-SECRET");
      rmSync(join(bed.papHome, "state.db"));
      symlinkSync(target("real.db"), join(bed.papHome, "state.db"));
      const deny = createDenySet(
        { files: [join(bed.papHome, "state.db")], folders: [join(bed.papHome, "backups")], skip: [] },
        later(),
      );
      expect(await deny.has(await st(target("real.db")))).toBe(true);
      expect(await deny.has(await st(join(bed.papHome, "backups", "b.db")))).toBe(true);
    });

    it("stops on a cycle and still vouches for the rest", async () => {
      symlinkSync(bed.papHome, join(bed.papHome, "loop"));
      mkdirSync(join(bed.papHome, "a"));
      mkdirSync(join(bed.papHome, "b"));
      symlinkSync(join(bed.papHome, "b"), join(bed.papHome, "a", "to-b"));
      symlinkSync(join(bed.papHome, "a"), join(bed.papHome, "b", "to-a"));
      const deny = createDenySet(walkOnly(), later());
      expect(await deny.has(await st(join(bed.papHome, "state.db")))).toBe(true);
      const alias = join(bed.proj, "a2.txt");
      linkSync(join(bed.proj, "a.txt"), alias);
      expect(await deny.has(await st(alias))).toBe(false);
    });

    it("counts followed entries in the cap", async () => {
      for (let i = 0; i < 12; i++) bed.file(join(target("many"), `f${i}`));
      symlinkSync(target("many"), join(bed.papHome, "many"));
      const alias = join(bed.proj, "a2.txt");
      linkSync(join(bed.proj, "a.txt"), alias);
      expect(await createDenySet(walkOnly(), later(), 15).has(await st(alias))).toBe(true);
      expect(await createDenySet(walkOnly(), later(), 1000).has(await st(alias))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      "fails closed when a link leads to something unreadable",
      async () => {
        bed.file(join(bed.home, "locked", "f"));
        symlinkSync(join(bed.home, "locked", "f"), join(bed.papHome, "dangling-ish"));
        const alias = join(bed.proj, "a2.txt");
        linkSync(join(bed.proj, "a.txt"), alias);
        chmodSync(join(bed.home, "locked"), 0o000);
        try {
          expect(await createDenySet(walkOnly(), later()).has(await st(alias))).toBe(true);
        } finally {
          chmodSync(join(bed.home, "locked"), 0o755);
        }
      },
    );

    it("lets a dangling link be", async () => {
      symlinkSync(join(bed.home, "nowhere"), join(bed.papHome, "gone"));
      const alias = join(bed.proj, "a2.txt");
      linkSync(join(bed.proj, "a.txt"), alias);
      expect(await createDenySet(walkOnly(), later()).has(await st(alias))).toBe(false);
    });

    it("logs each link it follows, with its place (N5)", async () => {
      bed.file(join(target("a"), "f"));
      symlinkSync(target("a"), join(bed.papHome, "to-a"));
      symlinkSync(join(target("a"), "f"), join(bed.papHome, "to-f"));
      const { logger, lines } = captureLogger();
      await createDenySet(walkOnly(), later(), 1000, 1000, { logger }).has(
        await st(join(bed.proj, "src", "a.ts")),
      );
      const followed = lines.filter((line) => line.msg === "deny_walk_link_followed");
      expect(followed.map((line) => line.path).sort()).toEqual([
        join(bed.papHome, "to-a"),
        join(bed.papHome, "to-f"),
      ]);
    });

    it("does not walk a skipped folder reached through a link under another name (R4)", async () => {
      const open = join(bed.papHome, "worktrees", "x", "f.txt");
      bed.file(open);
      symlinkSync(join(bed.papHome, "worktrees"), join(bed.papHome, "wt"));
      const deny = createDenySet(
        { files: [], folders: [bed.papHome], skip: [join(bed.papHome, "worktrees")] },
        later(),
      );
      expect(await deny.has(await st(open))).toBe(false);
      expect(await deny.has(await st(join(bed.papHome, "state.db")))).toBe(true);
    });
  });
});

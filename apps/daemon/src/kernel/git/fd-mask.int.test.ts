import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { shellEnv } from "../pty/env.ts";
import { ptyKill } from "../pty/kill.ts";
import { loadNodePty } from "../pty/load.ts";
import { ptySpec, type PtyProcess, spawnPty } from "../pty/spawn.ts";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";

let bed: GitBed;
const open: PtyProcess[] = [];
beforeEach(() => {
  bed = createGitBed();
});
afterEach(async () => {
  for (const pty of open.splice(0)) await ptyKill(pty, { clock: createSystemClock(), warn: () => {} });
  bed.dispose();
});

/** MC38: a repository-local clean filter (the documented residual of MC13) runs under git; it must not hold the daemon's PTY masters. */
describe("git's children and the daemon's terminals (MC38)", () => {
  it("a filter driver sees no /dev/ptmx while a terminal is open", async () => {
    const pty = loadNodePty(silentLogger);
    if (pty === null) throw new Error("node-pty did not load");
    const env = shellEnv({ PATH: process.env.PATH, HOME: bed.home, SHELL: "/bin/sh" });
    open.push(
      spawnPty(
        pty,
        ptySpec({ shell: "/bin/sh", cwd: bed.dir, cols: 80, rows: 24, env, scope: null, umask: 0o022 }),
        silentLogger,
      ),
    );
    const dump = join(bed.dir, "fds.txt");
    const script = join(bed.dir, "dump.sh");
    writeFileSync(script, `#!/bin/sh\nls -l /proc/$$/fd > '${dump}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(bed.root, ".gitattributes"), "*.txt filter=probe\n");
    bed.git(bed.root, "config", "filter.probe.clean", script);
    writeFileSync(join(bed.root, "a.txt"), "two\n");
    await bed.runner().run(bed.root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(dump), "control: the filter ran").toBe(true);
    const seen = readFileSync(dump, "utf8");
    expect(seen).not.toContain("/dev/ptmx");
    expect(seen).not.toContain("/dev/pts/");
  });
});

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitArgs, gitEnv } from "./exec.ts";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";

let bed: GitBed;
let root: string;
beforeEach(() => {
  bed = createGitBed();
  root = bed.root;
});
afterEach(() => bed.dispose());

const commitChange = (): void => {
  writeFileSync(join(root, "a.txt"), "two\n");
  bed.git(root, "commit", "-q", "-am", "second");
};
/** A killed orphan can stay a zombie until the container's init reaps it: that is dead for this purpose. */
const alive = (pid: number): boolean => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};

describe("diff, log and show never run a per-driver program (MC12)", () => {
  it.each([
    ["command", "diff.evil.command", ["diff", "HEAD~1", "HEAD"]],
    ["textconv", "diff.evil.textconv", ["diff", "HEAD~1", "HEAD"]],
    ["textconv", "diff.evil.textconv", ["show", "HEAD"]],
  ])("a planted %s (%s) through %j", async (_name, key, args) => {
    const { script, marker } = bed.plant("driver");
    commitChange();
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
    bed.git(root, "config", key, script);
    bed.git(root, ...args);
    expect(existsSync(marker), "control: plain git runs the plant").toBe(true);
    rmSync(marker);
    await expect(bed.runner().run(root, args)).resolves.toMatchObject({ code: 0 });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("signature checks (I2, MC16)", () => {
  const KINDS = [
    ["openpgp", "gpg.program", "-----BEGIN PGP SIGNATURE-----", "-----END PGP SIGNATURE-----"],
    ["x509", "gpg.x509.program", "-----BEGIN SIGNED MESSAGE-----", "-----END SIGNED MESSAGE-----"],
    ["ssh", "gpg.ssh.program", "-----BEGIN SSH SIGNATURE-----", "-----END SSH SIGNATURE-----"],
  ] as const;
  // Config-driven triggers go through the runner; caller-driven ones are refused by the runner (runner.test.ts), so
  // they run with the runner's flags directly: the blank programs are the second line behind the option allowlist.
  const TRIGGERS: Array<[string, string[], Array<[string, string]>, boolean]> = [
    ["log.showSignature", ["log"], [["log.showSignature", "true"]], false],
    ["format.pretty", ["log"], [["format.pretty", "format:%G? %s"]], false],
    ["format.pretty through show", ["show", "HEAD"], [["format.pretty", "format:%G? %s"]], false],
    ["--show-signature", ["log", "-1", "--show-signature"], [], true],
    ["%G? in --format", ["log", "-1", "--format=%G?"], [], true],
    ["%GS in show --pretty", ["show", "-s", "--pretty=format:%GS", "HEAD"], [], true],
  ];

  /** A commit whose gpgsig header is well-formed enough for git to call the verifier, and the planted verifier. */
  function signedCommit(begin: string, end: string): void {
    const tree = bed.git(root, "rev-parse", "HEAD^{tree}").trim();
    const raw = [
      `tree ${tree}`,
      "author t <t@example.com> 1 +0000",
      "committer t <t@example.com> 1 +0000",
      `gpgsig ${begin}`,
      " ",
      " abc",
      ` ${end}`,
      "",
      "signed",
      "",
    ].join("\n");
    const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: root,
      env: bed.setupEnv(),
      input: raw,
      encoding: "utf8",
    }).trim();
    bed.git(root, "update-ref", "refs/heads/main", oid);
  }

  const cases = KINDS.flatMap((kind) => TRIGGERS.map((trigger) => [kind, trigger] as const));
  it.each(cases)("%j never runs its verifier through %j", async (kind, trigger) => {
    const [, key, begin, end] = kind;
    const [, args, config, direct] = trigger;
    const { script, marker } = bed.plant("gpg");
    signedCommit(begin, end);
    bed.git(root, "config", key, script);
    const signers = join(bed.dir, "signers");
    writeFileSync(signers, "");
    bed.git(root, "config", "gpg.ssh.allowedSignersFile", signers);
    for (const [k, v] of config) bed.git(root, "config", k, v);
    bed.git(root, ...args);
    expect(existsSync(marker), "control: plain git runs the plant").toBe(true);
    rmSync(marker);
    if (direct) {
      const env = gitEnv({ PATH: process.env.PATH, HOME: bed.home }, root);
      try {
        execFileSync("git", gitArgs(root, args), { env, stdio: "ignore" });
      } catch {
        // The verdict does not matter, only whether the plant ran.
      }
    } else {
      await bed.runner().run(root, args, { okCodes: [0, 1] });
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("diff.submodule (I3)", () => {
  it("a submodule's own diff driver never runs through the superproject's diff", async () => {
    const { script, marker } = bed.plant("subdriver");
    const src = join(bed.dir, "subsrc");
    bed.initRepo(src);
    bed.git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "vendor");
    bed.git(root, "commit", "-q", "-m", "sub");
    const vendor = join(root, "vendor");
    writeFileSync(join(vendor, ".gitattributes"), "*.txt diff=evil\n");
    bed.git(vendor, "config", "diff.evil.command", script);
    writeFileSync(join(vendor, "a.txt"), "dirty\n");
    bed.git(root, "config", "diff.submodule", "diff");
    bed.git(root, "diff", "HEAD");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    await bed.runner().run(root, ["diff", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses --submodule=diff from the caller", async () => {
    await expect(bed.runner().run(root, ["diff", "--submodule=diff", "HEAD"])).rejects.toMatchObject({
      kind: "failed",
    });
  });
});

describe("lazy fetch and protocols (I4)", () => {
  const partialClone = (): string => {
    const origin = join(bed.dir, "origin");
    bed.initRepo(origin);
    bed.git(origin, "config", "uploadpack.allowFilter", "true");
    bed.git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = join(bed.dir, "clone");
    bed.git(
      bed.dir,
      "-c",
      "protocol.file.allow=always",
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      `file://${origin}`,
      clone,
    );
    return clone;
  };

  it.each(["uploadpack", "ext"])("a planted %s program never runs on a missing blob", async (shape) => {
    const { script, marker } = bed.plant("promisor");
    const clone = partialClone();
    if (shape === "uploadpack") {
      bed.git(clone, "config", "remote.origin.uploadpack", script);
      bed.git(clone, "config", "protocol.file.allow", "always");
    } else {
      bed.git(clone, "config", "remote.origin.url", `ext::${script}`);
      bed.git(clone, "config", "protocol.ext.allow", "always");
    }
    // The plant is not a real server, so the fetch (and the command) fails; only the marker matters here.
    expect(() =>
      execFileSync("git", ["cat-file", "blob", "HEAD:a.txt"], {
        cwd: clone,
        env: bed.setupEnv(),
        stdio: "ignore",
      }),
    ).toThrow();
    expect(existsSync(marker), "control: plain git lazy-fetches through the plant").toBe(true);
    rmSync(marker);
    await expect(bed.runner().run(clone, ["cat-file", "blob", "HEAD:a.txt"])).rejects.toMatchObject({
      kind: "failed",
    });
    await expect(bed.runner().run(clone, ["diff", "HEAD"])).rejects.toMatchObject({ kind: "failed" });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a folder that only looks like a bare repository (I5)", () => {
  function fakeBare(): { folder: string; marker: string } {
    const { script, marker } = bed.plant("bare");
    const real = join(bed.dir, "real");
    bed.initRepo(real);
    const folder = join(bed.dir, "fake");
    mkdirSync(folder);
    cpSync(join(real, ".git"), folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "one\n");
    writeFileSync(join(folder, ".gitattributes"), "*.txt filter=evil\n");
    bed.git(folder, "config", "core.bare", "false");
    bed.git(folder, "config", "core.worktree", folder);
    bed.git(folder, "config", "filter.evil.clean", script);
    writeFileSync(join(folder, "a.txt"), "one\n", { flag: "w" });
    return { folder, marker };
  }

  it("is not a repository and runs nothing", async () => {
    const { folder, marker } = fakeBare();
    // Outside the folder so the ceiling is irrelevant: the folder itself is the problem.
    const env = { ...bed.setupEnv() };
    execFileSync("git", ["status"], { cwd: folder, env, stdio: "ignore" });
    expect(existsSync(marker), "control: plain git treats the folder as a repository").toBe(true);
    rmSync(marker);
    const runner = bed.runner();
    await expect(runner.run(folder, ["rev-parse", "--show-toplevel"])).rejects.toMatchObject({
      kind: "failed",
    });
    await expect(
      runner.run(folder, ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"]),
    ).rejects.toMatchObject({ kind: "failed" });
    expect(existsSync(marker)).toBe(false);
  });

  it("an ordinary repository, a submodule as root and a linked worktree still work", async () => {
    const runner = bed.runner();
    const top = async (path: string) =>
      (await runner.run(path, ["rev-parse", "--show-toplevel"])).stdout.toString("utf8").trim();
    expect(await top(root)).toBe(root);
    const src = join(bed.dir, "subsrc");
    bed.initRepo(src);
    bed.git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "vendor");
    bed.git(root, "commit", "-q", "-m", "sub");
    expect(await top(join(root, "vendor"))).toBe(join(root, "vendor"));
    await runner.run(root, ["status", "--porcelain=v2", "-z"]);
    const linked = join(bed.dir, "linked");
    bed.git(root, "worktree", "add", "-q", "-b", "other", linked);
    expect(await top(linked)).toBe(linked);
  });
});

describe("a stuck git and its descendants (M3)", () => {
  function slowFilter(): { pidFile: string } {
    const pidFile = join(bed.dir, "child.pid");
    const script = join(bed.dir, "slow.sh");
    writeFileSync(script, `#!/bin/sh\nsleep 60 >/dev/null 2>&1 &\necho $! > '${pidFile}'\nwait\n`, {
      mode: 0o755,
    });
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=slow\n");
    bed.git(root, "config", "filter.slow.clean", script);
    writeFileSync(join(root, "a.txt"), "two\n");
    return { pidFile };
  }
  const childPid = (pidFile: string): number => Number(readFileSync(pidFile, "utf8").trim());

  it("kills the whole process group on timeout", async () => {
    const { pidFile } = slowFilter();
    await expect(
      bed.runner().run(root, ["status", "--porcelain=v2", "-z"], { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ kind: "timeout" });
    const pid = childPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
  });

  it("kills a descendant that outlives git's own exit", async () => {
    const pidFile = join(bed.dir, "orphan.pid");
    const script = join(bed.dir, "orphan.sh");
    writeFileSync(script, `#!/bin/sh\nsleep 60 >/dev/null 2>&1 &\necho $! > '${pidFile}'\ncat\n`, {
      mode: 0o755,
    });
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=slow\n");
    bed.git(root, "config", "filter.slow.clean", script);
    writeFileSync(join(root, "a.txt"), "two\n");
    await bed.runner().run(root, ["status", "--porcelain=v2", "-z"]);
    const pid = childPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
  });
});

describe("a program that leaves git's process group (M3)", () => {
  it("does not hold the call open through git's pipes", async () => {
    const pidFile = join(bed.dir, "escaped.pid");
    const script = join(bed.dir, "escape.sh");
    // setsid: its own session, so the group kill misses it; it keeps the inherited stderr pipe open.
    writeFileSync(
      script,
      `#!/bin/sh\nsetsid sh -c 'echo $$ > "$0"; exec sleep 60' '${pidFile}' >/dev/null &\nwhile [ ! -s '${pidFile}' ]; do :; done\ncat\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=slow\n");
    bed.git(root, "config", "filter.slow.clean", script);
    writeFileSync(join(root, "a.txt"), "two\n");
    try {
      await expect(bed.runner().run(root, ["status", "--porcelain=v2", "-z"])).resolves.toMatchObject({
        code: 0,
      });
    } finally {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid > 1) process.kill(pid, "SIGKILL");
    }
  });
});

describe("stdin", () => {
  const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n";
  const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a\n";

  it("is empty unless an input is given, so a read of stdin ends", async () => {
    const out = await bed.runner().run(root, ["hash-object", "--stdin"], { timeoutMs: 3000 });
    expect(out.stdout.toString("utf8")).toBe(EMPTY_BLOB);
  });

  it("carries the input when one is given", async () => {
    const out = await bed.runner().run(root, ["hash-object", "--stdin"], { input: Buffer.from("hello\n") });
    expect(out.stdout.toString("utf8")).toBe(HELLO_BLOB);
  });
});

describe("no optional locks", () => {
  it("a status on a stale index leaves the index file alone", async () => {
    const index = join(root, ".git", "index");
    const old = new Date(Date.now() - 60_000);
    const stale = (): void => {
      utimesSync(join(root, "a.txt"), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
      utimesSync(index, old, old);
    };
    stale();
    bed.git(root, "status");
    expect(statSync(index).mtimeMs, "control: plain status rewrites the index").toBeGreaterThan(
      old.getTime() + 1000,
    );
    stale();
    const before = statSync(index).mtimeMs;
    await bed.runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(statSync(index).mtimeMs).toBe(before);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });
});

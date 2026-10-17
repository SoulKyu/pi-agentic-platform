import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gnuTar, hiddenHardLink, hiddenSymlink, smuggleArchive } from "../testing/tar-fixtures.ts";
import { assertPlainTree, ownerOnly } from "./verify-stage.ts";

const REFUSAL = "the extracted tree holds a link or a special file";

let scratch: string;
let stage: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-verify-stage-"));
  stage = join(scratch, "stage");
  mkdirSync(stage);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const mode = (path: string): number => lstatSync(path).mode & 0o7777;

/** The same extraction the restore does; tar exits 2 when the smuggled member below the link fails, the link has landed. */
const extract = (archive: string, umask = "022"): void => {
  try {
    execFileSync(
      "sh",
      [
        "-c",
        `umask ${umask}; exec tar -xzf "$1" -C "$2" --no-same-owner --no-same-permissions --no-overwrite-dir`,
        "sh",
        archive,
        stage,
      ],
      { stdio: "pipe" },
    );
  } catch {
    // see above
  }
};

describe("assertPlainTree, without the reader", () => {
  it("refuses the stage of the hidden-symlink archive and leaves every mode as tar wrote it", () => {
    const archive = join(scratch, "a.tar.gz");
    smuggleArchive(scratch, archive, hiddenSymlink(join(scratch, "elsewhere")));
    extract(archive);
    expect(lstatSync(join(stage, "agents/evil")).isSymbolicLink()).toBe(true);
    const before = mode(join(stage, "agents/x"));
    expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
    expect(mode(join(stage, "agents/x"))).toBe(before);
    expect(mode(join(stage, "agents"))).toBe(0o755);
  });

  it("refuses the stage of the hidden-hard-link archive", () => {
    const archive = join(scratch, "a.tar.gz");
    smuggleArchive(scratch, archive, hiddenHardLink("agents/a"));
    extract(archive);
    expect(lstatSync(join(stage, "agents/b")).nlink).toBe(2);
    expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
  });

  it("refuses a FIFO, a socket, a file with another hard link and a symlinked folder", async () => {
    mkdirSync(join(stage, "agents"));
    execFileSync("mkfifo", [join(stage, "agents/pipe")]);
    expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
    rmSync(join(stage, "agents/pipe"));

    const socketPath = join(stage, "agents/sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(socketPath, { force: true });

    writeFileSync(join(stage, "agents/one"), "x");
    linkSync(join(stage, "agents/one"), join(stage, "agents/two"));
    expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
    rmSync(join(stage, "agents/two"));
    expect(assertPlainTree(stage)).toBe(3);

    mkdirSync(join(scratch, "real"));
    symlinkSync(join(scratch, "real"), join(stage, "agents/folder"));
    expect(() => assertPlainTree(stage)).toThrow(REFUSAL);
  });

  it.skipIf(process.getuid?.() === 0)(
    "says a fixed sentence, without the archive's path, when a folder cannot be read",
    () => {
      mkdirSync(join(stage, "agents/locked-by-the-archive"), { recursive: true });
      chmodSync(join(stage, "agents/locked-by-the-archive"), 0o000);
      try {
        let message = "";
        try {
          assertPlainTree(stage);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe("the extracted tree could not be read (EACCES)");
      } finally {
        chmodSync(join(stage, "agents/locked-by-the-archive"), 0o700);
      }
    },
  );

  it("refuses a stage root that is itself a link", () => {
    symlinkSync(stage, join(scratch, "alias"));
    expect(() => assertPlainTree(join(scratch, "alias"))).toThrow(REFUSAL);
  });

  it("returns the entry count of a clean stage, root included", () => {
    mkdirSync(join(stage, "agents/one"), { recursive: true });
    writeFileSync(join(stage, "agents/one/run.sh"), "#!/bin/sh");
    writeFileSync(join(stage, "state.db"), "db");
    mkdirSync(join(stage, "exports"));
    expect(assertPlainTree(stage)).toBe(6);
  });

  it("refuses a tree with more entries than the limit", () => {
    for (const name of ["a", "b", "c"]) writeFileSync(join(stage, name), "x");
    expect(assertPlainTree(stage, 4)).toBe(4);
    expect(() => assertPlainTree(stage, 3)).toThrow("the extracted tree is larger than a backup can be");
  });
});

describe("ownerOnly", () => {
  it("under umask 077 keeps a script at 0700, a data file at 0600 and folders at 0700", () => {
    const tree = join(scratch, "tree");
    mkdirSync(join(tree, "agents/one"), { recursive: true });
    writeFileSync(join(tree, "agents/one/run.sh"), "#!/bin/sh\n");
    writeFileSync(join(tree, "agents/one/data.txt"), "d");
    chmodSync(join(tree, "agents/one/run.sh"), 0o755);
    const archive = join(scratch, "a.tar.gz");
    gnuTar(tree, archive, ["agents", "agents/one", "agents/one/run.sh", "agents/one/data.txt"]);
    extract(archive, "077");
    ownerOnly(stage);
    expect(mode(join(stage, "agents/one/run.sh"))).toBe(0o700);
    expect(mode(join(stage, "agents/one/data.txt"))).toBe(0o600);
    expect(mode(join(stage, "agents/one"))).toBe(0o700);
    expect(mode(join(stage, "agents"))).toBe(0o700);
    expect(mode(stage)).toBe(0o700);
  });

  it("never grants more: group and other bits are dropped, 0444 becomes 0600, a read-only folder becomes 0700", () => {
    mkdirSync(join(stage, "d"));
    writeFileSync(join(stage, "d/ro"), "x");
    writeFileSync(join(stage, "d/wide"), "x");
    writeFileSync(join(stage, "d/nothing"), "x");
    chmodSync(join(stage, "d/ro"), 0o444);
    chmodSync(join(stage, "d/wide"), 0o777);
    chmodSync(join(stage, "d/nothing"), 0o070);
    chmodSync(join(stage, "d"), 0o555);
    ownerOnly(stage);
    expect(mode(join(stage, "d/ro"))).toBe(0o600);
    expect(mode(join(stage, "d/wide"))).toBe(0o700);
    expect(mode(join(stage, "d/nothing"))).toBe(0o600);
    expect(mode(join(stage, "d"))).toBe(0o700);
  });

  it("never follows a link even when called on a tree that holds one (it refuses, the target keeps its mode)", () => {
    const outside = join(scratch, "outside");
    writeFileSync(outside, "x");
    chmodSync(outside, 0o644);
    symlinkSync(outside, join(stage, "link"));
    expect(() => ownerOnly(stage)).toThrow(REFUSAL);
    expect(mode(outside)).toBe(0o644);
  });

  it("refuses a file that has another name, like a link: it would change the other name's mode", () => {
    const outside = join(scratch, "outside");
    writeFileSync(outside, "x");
    chmodSync(outside, 0o444);
    linkSync(outside, join(stage, "inner"));
    expect(() => ownerOnly(stage)).toThrow(REFUSAL);
    expect(mode(outside)).toBe(0o444);
  });
});

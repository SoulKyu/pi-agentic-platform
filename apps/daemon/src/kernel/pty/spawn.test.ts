import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScopeLaunch } from "../supervisor/scope.ts";
import { clampSize, PTY_COLS, PTY_ROWS, ptySpec, shellOf } from "./spawn.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pap-spawn-"));
  dirs.push(dir);
  return dir;
}

describe("shellOf", () => {
  it("falls back to /bin/sh for a relative, missing, non-executable, folder or NUL-holding SHELL", () => {
    const dir = tmp();
    const plain = join(dir, "plain");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    for (const SHELL of ["bash", join(dir, "missing"), plain, folder, "/bin/b\u0000", "", undefined])
      expect(shellOf({ SHELL }), String(SHELL)).toBe("/bin/sh");
    expect(shellOf({})).toBe("/bin/sh");
  });

  it("returns an absolute executable regular file as given, a symlink to one included", () => {
    const dir = tmp();
    const shell = join(dir, "myshell");
    writeFileSync(shell, "#!/bin/sh\n");
    chmodSync(shell, 0o755);
    expect(shellOf({ SHELL: shell })).toBe(shell);
    expect(shellOf({ SHELL: "/bin/sh" })).toBe("/bin/sh");
  });
});

describe("ptySpec", () => {
  const base = { cwd: "/work", cols: 100, rows: 30, env: { A: "b" }, scope: null, umask: 0o022 };
  const wrapper = ["-c", 'umask "$1" && shift && exec "$@"', "pap-shell", "0022"];

  it("passes -l to the known shells only, by basename, and nothing else from outside", () => {
    expect(ptySpec({ ...base, shell: "/bin/bash" })).toMatchObject({
      file: "/bin/sh",
      args: [...wrapper, "/bin/bash", "-l"],
    });
    expect(ptySpec({ ...base, shell: "/usr/bin/zsh" }).args).toEqual([...wrapper, "/usr/bin/zsh", "-l"]);
    expect(ptySpec({ ...base, shell: "/usr/bin/python3" })).toMatchObject({
      file: "/bin/sh",
      args: [...wrapper, "/usr/bin/python3"],
    });
  });

  it("fixes the options: type, encoding null, no flow control, the judged cwd and the given env", () => {
    expect(ptySpec({ ...base, shell: "/bin/sh" }).options).toEqual({
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: "/work",
      env: { A: "b" },
      encoding: null,
      handleFlowControl: false,
    });
  });

  it("runs the shell behind the scope's command, with the scope's environment", () => {
    const scope: ScopeLaunch = {
      command: "/usr/bin/systemd-run",
      args: ["--user", "--scope", "--"],
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    };
    const spec = ptySpec({ ...base, shell: "/bin/bash", scope });
    expect(spec.file).toBe("/usr/bin/systemd-run");
    expect(spec.args).toEqual(["--user", "--scope", "--", "/bin/sh", ...wrapper, "/bin/bash", "-l"]);
    expect(spec.options.env).toEqual({ A: "b", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(ptySpec({ ...base, shell: "/usr/bin/python3", scope }).args.slice(-1)).toEqual([
      "/usr/bin/python3",
    ]);
  });

  it("starts the shell under the daemon's starting umask, written as an octal word", () => {
    const mask = (umask: number) => ptySpec({ ...base, shell: "/bin/sh", umask }).args[3];
    expect([mask(0o002), mask(0o022), mask(0o077), mask(0)]).toEqual(["0002", "0022", "0077", "0000"]);
  });

  it("clamps the size: 0 to 2, 9999 to 500, a non-integer to 80 x 24", () => {
    const size = (cols: number, rows: number) => {
      const { options } = ptySpec({ ...base, shell: "/bin/sh", cols, rows });
      return [options.cols, options.rows];
    };
    expect(size(0, 0)).toEqual([2, 2]);
    expect(size(9999, 1000)).toEqual([500, 200]);
    expect(size(Number.NaN, Number.NaN)).toEqual([80, 24]);
    expect(size(2.5, 3.5)).toEqual([80, 24]);
    expect(size(Infinity, -Infinity)).toEqual([80, 24]);
    expect(clampSize(500, PTY_COLS)).toBe(500);
    expect(clampSize(2, PTY_ROWS)).toBe(2);
  });
});

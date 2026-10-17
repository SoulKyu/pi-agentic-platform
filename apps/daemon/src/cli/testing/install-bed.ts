import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeFetch, routesFor, runCmd, type Fixture } from "./update-feed.ts";
import { makeInstallCommand, type InstallSeams } from "../update/install-command.ts";

export const NODE = "22.14.0";

/** A `bash` that records its argv, cwd, the mode of the installer and its folder, and the environment; then exits `code`. */
export function setBash(fakeBin: string, code: number, extra = ""): void {
  const path = join(fakeBin, "bash");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `log="${fakeBin}/log"`,
      `echo "called" >> "$log"`,
      `printf '%s\\n' "$@" > "${fakeBin}/argv"`,
      `pwd -P > "${fakeBin}/cwd"`,
      `stat -c %a "$1" > "${fakeBin}/installer-mode"`,
      `stat -c %a "$(dirname "$1")" > "${fakeBin}/dir-mode"`,
      `ls "$(dirname "$1")" > "${fakeBin}/dir-listing"`,
      `env | sort > "${fakeBin}/env"`,
      extra,
      `exit ${code}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export const bashCalls = (fakeBin: string): number =>
  existsSync(join(fakeBin, "log")) ? readFileSync(join(fakeBin, "log"), "utf8").split("\n").length - 1 : 0;

export const seen = (fakeBin: string, name: string): string => readFileSync(join(fakeBin, name), "utf8");

export function command(f: Fixture | null, overrides: Partial<InstallSeams> = {}) {
  const served = fakeFetch(f === null ? {} : routesFor(f));
  return {
    served,
    cmd: makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
      ...overrides,
    }),
  };
}

export const run = (
  fakeBin: string,
  userHome: string,
  cmd: ReturnType<typeof command>["cmd"],
  args: string[],
  env: NodeJS.ProcessEnv = {},
) => runCmd(cmd, args, { homedir: userHome, env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ...env } });

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** A fake `npm` and `git` first on the PATH: each records its argv in `log`, so a test can tell they never ran. */
export function fakeInstallers(
  bin: string,
  log: string,
  base: string | undefined = process.env.PATH,
): string {
  mkdirSync(bin, { recursive: true });
  for (const name of ["npm", "git"]) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  return `${bin}${delimiter}${base ?? ""}`;
}
/**
 * What the fakes were asked, minus `npm root -g`: Pi asks where global packages live (a local query that installs
 * nothing) whatever the mode. Anything else, an `npm install` or a `git clone`, is an install.
 */
export const installCalls = (log: string): string[] =>
  (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []).filter(
    (line) => line !== "" && line !== "npm root -g",
  );

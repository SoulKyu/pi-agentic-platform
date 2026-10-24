import { LFS_ENTRIES } from "./protected-paths.ts";

const OWNERS_OWN_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);
const PROGRAM_KEY = /^filter\.(.*)\.(clean|smudge|process)$/;
/** A repository with more drivers than this is not ordinary: the call is refused (the environment has a size limit). */
export const MAX_FILTER_DRIVERS = 64;

/** The drivers to empty from the output of `git config --null --show-scope --get-regexp ^filter\.`, or null when there are too many to name. */
export function driversToDisable(scan: Uint8Array): string[] | null {
  const fields = new TextDecoder().decode(scan).split("\0");
  const names = new Set<string>();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at] as string;
    const entry = fields[at + 1] as string;
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    const program = PROGRAM_KEY.exec(key);
    if (program === null || OWNERS_OWN_SCOPES.has(scope)) continue;
    const [, name, kind] = program as unknown as [string, string, string];
    // One entry that is not the standard one empties the whole `lfs` driver.
    if (!(name === "lfs" && value !== null && LFS_ENTRIES.get(kind) === value)) names.add(name);
  }
  if (names.size > MAX_FILTER_DRIVERS) return null;
  return [...names];
}

/** `GIT_CONFIG_COUNT` entries that empty each driver and stop `required` from failing the call. */
export function disablingEnv(names: readonly string[]): Record<string, string> {
  const entries = names.flatMap((name): Array<[string, string]> => [
    [`filter.${name}.clean`, ""],
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"],
  ]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], at) => {
    env[`GIT_CONFIG_KEY_${at}`] = key;
    env[`GIT_CONFIG_VALUE_${at}`] = value;
  });
  return env;
}

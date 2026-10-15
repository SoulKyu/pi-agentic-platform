/**
 * The keys a repository's own config sets in a `--null --show-scope --get-regexp` scan (`scope NUL key LF value NUL`):
 * `system` and `global` are the owner's, `command` is pap's own `-c` set (M9R14). An unknown scope counts as the
 * repository's, as in the filter guard.
 */
export function repositoryKeys(scan: Buffer): string[] {
  const fields = scan.toString("utf8").split("\0");
  const keys: string[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at] as string;
    if (scope === "system" || scope === "global" || scope === "command") continue;
    const entry = fields[at + 1] as string;
    const newline = entry.indexOf("\n");
    keys.push(newline === -1 ? entry : entry.slice(0, newline));
  }
  return keys;
}

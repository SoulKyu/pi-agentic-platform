export interface PorcelainBranch {
  oid: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface PorcelainEntry {
  kind: "ordinary" | "renamed" | "copied" | "unmerged" | "untracked";
  /** Index state letter (`.` unchanged); `?` for an untracked path. */
  index: string;
  worktree: string;
  path: string;
  origPath: string | null;
  /** Git's four-character submodule field (`N...`, `S.M.`); `N...` for an untracked path. */
  submodule: string;
}

export interface PorcelainStatus {
  branch: PorcelainBranch;
  entries: PorcelainEntry[];
}

/** Space-separated fields before the path (the path may hold spaces): `1` has 8, `2` has 9, `u` has 10. */
const FIELDS_BEFORE_PATH = { "1": 8, "2": 9, u: 10 } as const;

function splitFields(record: string, count: number): string[] | null {
  const fields: string[] = [];
  let from = 0;
  for (let n = 0; n < count; n += 1) {
    const space = record.indexOf(" ", from);
    if (space < 0) return null;
    fields.push(record.slice(from, space));
    from = space + 1;
  }
  fields.push(record.slice(from));
  return fields;
}

/** `git status --porcelain=v2 -z --branch`. Unknown or malformed records are skipped, the rest is still read. */
export function parsePorcelainV2(out: Buffer): PorcelainStatus {
  const branch: PorcelainBranch = {
    oid: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
  };
  const entries: PorcelainEntry[] = [];
  const records = out.toString("utf8").split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? "";
    if (record.startsWith("# ")) {
      readHeader(record.slice(2), branch);
    } else if (record.startsWith("? ")) {
      entries.push({
        kind: "untracked",
        index: "?",
        worktree: "?",
        path: record.slice(2),
        origPath: null,
        submodule: "N...",
      });
    } else if (record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ")) {
      const type = record[0] as keyof typeof FIELDS_BEFORE_PATH;
      const fields = splitFields(record, FIELDS_BEFORE_PATH[type]);
      const xy = fields?.[1];
      if (!fields || xy?.length !== 2) continue;
      const path = fields[fields.length - 1] ?? "";
      if (type === "2") {
        const origPath = records[i + 1];
        if (origPath === undefined || origPath === "") continue;
        i += 1;
        entries.push({
          kind: fields[8]?.startsWith("C") ? "copied" : "renamed",
          index: xy.slice(0, 1),
          worktree: xy.slice(1),
          path,
          origPath,
          submodule: fields[2] ?? "",
        });
      } else {
        entries.push({
          kind: type === "u" ? "unmerged" : "ordinary",
          index: xy.slice(0, 1),
          worktree: xy.slice(1),
          path,
          origPath: null,
          submodule: fields[2] ?? "",
        });
      }
    }
  }
  return { branch, entries };
}

function readHeader(header: string, branch: PorcelainBranch): void {
  const space = header.indexOf(" ");
  const key = header.slice(0, space);
  const value = header.slice(space + 1);
  if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
  else if (key === "branch.head") {
    branch.detached = value === "(detached)";
    branch.head = branch.detached ? null : value;
  } else if (key === "branch.upstream") branch.upstream = value;
  else if (key === "branch.ab") {
    const match = /^\+(\d+) -(\d+)$/.exec(value);
    if (match) {
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
    }
  }
}

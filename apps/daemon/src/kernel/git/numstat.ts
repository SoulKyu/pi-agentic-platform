export interface NumstatRow {
  additions: number | null;
  deletions: number | null;
}

const ROW = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
const count = (text: string): number | null => (text === "-" ? null : Number(text));

/** `git diff --numstat -z`: a binary file counts `-`/`-` (nulls); a rename is `a\td\t` then the old and new paths, keyed by the new one. */
export function parseNumstat(out: Buffer): Map<string, NumstatRow> {
  const rows = new Map<string, NumstatRow>();
  const tokens = out.toString("utf8").split("\0");
  let i = 0;
  while (i < tokens.length) {
    const match = ROW.exec(tokens[i] ?? "");
    if (!match) {
      i += 1;
      continue;
    }
    const row = { additions: count(match[1] ?? ""), deletions: count(match[2] ?? "") };
    if (match[3] === "") {
      const renamed = tokens[i + 2];
      if (renamed) rows.set(renamed, row);
      i += 3;
    } else {
      rows.set(match[3] ?? "", row);
      i += 1;
    }
  }
  return rows;
}

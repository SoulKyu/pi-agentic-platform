/** Code point order, which is not UTF-16 order for characters above U+FFFF. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const diff = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
}

const SEGMENT_START = new Set(["/", "-", "_", ".", " "]);
const START_BONUS = 6;
const RUN_BONUS = 10;
const BASENAME_PREFIX = 30;
const BASENAME_EXACT = 100;
const NONE = -1e9;

/** Only this many last characters of a path are scored (the file name and its folders): the work per path is bounded. */
export const RANK_TAIL_CHARS = 256;
/** Cells (path characters x query characters) one search may score, at most; past it the answer says `more` (I2). */
export const RANK_BUDGET_CELLS = 25_000_000;

/** Paths one search visits at most (the quick check is cheap but not free); above the git and walk caps. */
export const RANK_MAX_PATHS = 200_000;

/** Cells the last `score` call scored: zero when the quick check rejected the path (it costs the budget nothing). */
let scoredCells = 0;

// Two rows reused for every path: a search allocates nothing per path.
const rowA = new Float64Array(RANK_TAIL_CHARS);
const rowB = new Float64Array(RANK_TAIL_CHARS);

/** Best score of `query` as a case-insensitive subsequence of `path` (both lower-cased, `path` at most the tail), or null. */
function score(path: string, query: string): number | null {
  const n = path.length;
  const m = query.length;
  if (m > n) return null;
  const slash = path.lastIndexOf("/");
  // Quick refusal: the letters must appear in order.
  for (let i = 0, j = 0; j < m; j++) {
    i = path.indexOf(query[j] ?? "", i);
    if (i < 0) return null;
    i += 1;
  }
  scoredCells = n * m;
  const gain = (i: number): number => {
    const before = path[i - 1];
    return 1 + (i === 0 || (before !== undefined && SEGMENT_START.has(before)) ? START_BONUS : 0);
  };
  // previous[i]: the best score with query[0..j] matched and query[j] at path[i].
  let previous = rowA;
  let current = rowB;
  for (let i = 0; i < n; i++) previous[i] = path[i] === query[0] ? gain(i) : NONE;
  for (let j = 1; j < m; j++) {
    let bestBefore = NONE; // best of previous[0..i-2]
    current[0] = NONE;
    for (let i = 1; i < n; i++) {
      if (i >= 2) bestBefore = Math.max(bestBefore, previous[i - 2] ?? NONE);
      let value = NONE;
      if (path[i] === query[j]) {
        const best = Math.max((previous[i - 1] ?? NONE) + RUN_BONUS, bestBefore);
        if (best > NONE / 2) value = best + gain(i);
      }
      current[i] = value;
    }
    [previous, current] = [current, previous];
  }
  let total = NONE;
  for (let i = 0; i < n; i++) total = Math.max(total, previous[i] ?? NONE);
  if (total <= NONE / 2) return null;
  const base = path.slice(slash + 1);
  const exact = base === query ? BASENAME_EXACT : base.startsWith(query) ? BASENAME_PREFIX : 0;
  return total + exact;
}

export interface Ranked {
  readonly paths: string[];
  /** More paths matched than were returned, or the budget ran out before every path was scored. */
  readonly more: boolean;
  /** Cells scored: the work done. */
  readonly cells: number;
}

/**
 * The paths that match `query`, best first, at most `limit` of those `accept` allows. Pure: the score is a case-insensitive
 * subsequence match over the last 256 characters that favours segment starts, consecutive runs and a file name that starts
 * with the query; ties go to the shorter path, then to code point order. Scoring stops past `budget` cells actually scored, and the visit past `maxPaths` paths.
 */
export function rank(
  paths: readonly string[],
  query: string,
  limit: number,
  accept: (path: string) => boolean = () => true,
  budget: number = RANK_BUDGET_CELLS,
  maxPaths: number = RANK_MAX_PATHS,
): Ranked {
  const needle = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  let cells = 0;
  let exhausted = false;
  let visited = 0;
  for (const path of paths) {
    if (cells >= budget || visited === maxPaths) {
      exhausted = true;
      break;
    }
    const tail = path.length > RANK_TAIL_CHARS ? path.slice(-RANK_TAIL_CHARS) : path;
    const lowered = tail.toLowerCase();
    // toLowerCase can lengthen a string (U+0130): keep the rows' size.
    scoredCells = 0;
    const value = score(lowered.length > RANK_TAIL_CHARS ? lowered.slice(-RANK_TAIL_CHARS) : lowered, needle);
    cells += scoredCells;
    visited += 1;
    if (value !== null) scored.push({ path, score: value });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || compareCodePoints(a.path, b.path),
  );
  const out: string[] = [];
  let more = exhausted;
  for (const { path } of scored) {
    if (!accept(path)) continue;
    if (out.length === limit) {
      more = true;
      break;
    }
    out.push(path);
  }
  return { paths: out, more, cells };
}

import type { SecretSet } from "./redact.ts";

type Entries = SecretSet["entries"];
const EDGE_MIN = 4;
/** What a window cut inside a multi-byte character leaves in front of or behind the fragment. */
const REPLACEMENT = 0xfffd;
const MAX_REPLACEMENTS = 8;
/** Character comparisons one record, or one tool result, may spend on edges (M5R120). */
export const EDGE_BUDGET = 1_000_000;
export const EDGE_WITHHELD_TEXT = "[output hidden: pap-policy could not check its edges]";
/** What Pi's grep appends to a line it clipped at 500 characters. */
const TRUNCATED_NOTICE = "... [truncated]";

interface Shape {
  /** The secrets and their JSON-escaped forms: canonical JSON output carries the second. */
  readonly forms: Entries;
  readonly longest: number;
  readonly firstUnits: ReadonlySet<number>;
}
const shapes = new WeakMap<Entries, Shape>();

function shapeOf(entries: Entries): Shape {
  const known = shapes.get(entries);
  if (known) return known;
  const forms: Array<Entries[number]> = [];
  for (const entry of entries) {
    if (entry.value === "") continue;
    forms.push(entry);
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    if (escaped !== entry.value) forms.push({ ...entry, value: escaped });
  }
  const shape = {
    forms,
    longest: forms.reduce((max, form) => Math.max(max, form.value.length), 0),
    firstUnits: new Set(forms.map((form) => form.value.charCodeAt(0))),
  };
  shapes.set(entries, shape);
  return shape;
}

function charge(budget: { left: number }, steps: number): void {
  budget.left -= steps;
  if (budget.left < 0) throw new RangeError("edge budget spent");
}

/** The longest k (EDGE_MIN ≤ k < secret.length) such that `text` starts with the last k characters of `secret`. */
function headFragment(secret: string, text: string, budget: { left: number }): number {
  for (let k = Math.min(secret.length - 1, text.length); k >= EDGE_MIN; k--) {
    const from = secret.length - k;
    let i = 0;
    while (i < k && secret.charCodeAt(from + i) === text.charCodeAt(i)) i++;
    charge(budget, i + 1);
    if (i === k) return k;
  }
  return 0;
}

/** Where a tail fragment could start: the positions of `text` that hold the first character of some secret. */
function tailStarts(text: string, shape: Shape): number[] {
  const starts: number[] = [];
  for (let p = Math.max(0, text.length - shape.longest + 1); p <= text.length - EDGE_MIN; p++)
    if (shape.firstUnits.has(text.charCodeAt(p))) starts.push(p);
  return starts;
}

/** The longest k (EDGE_MIN ≤ k < secret.length) such that `text` ends with the first k characters of `secret`. */
function tailFragment(
  secret: string,
  text: string,
  budget: { left: number },
  starts: readonly number[],
): number {
  for (const p of starts) {
    const k = text.length - p;
    if (k >= secret.length || text.charCodeAt(p) !== secret.charCodeAt(0)) continue;
    let i = 1;
    while (i < k && text.charCodeAt(p + i) === secret.charCodeAt(i)) i++;
    charge(budget, i + 1);
    if (i === k) return k;
  }
  return 0;
}

function runOf(text: string, from: "start" | "end"): number {
  let n = 0;
  while (n < MAX_REPLACEMENTS && n < text.length) {
    const unit = text.charCodeAt(from === "start" ? n : text.length - 1 - n);
    if (unit !== REPLACEMENT) break;
    n++;
  }
  return n;
}

/**
 * Masks a head or a tail of a text that a cut took out of a secret (M5R120): a rolling window, a clip, a limit. A run of
 * U+FFFD beside the fragment (a cut inside a multi-byte character) goes with it. A head and a tail that would overlap
 * mask the whole text. Throws RangeError past the budget.
 */
export function maskEdges(
  text: string,
  entries: Entries,
  budget: { left: number },
  sides: { readonly head?: boolean; readonly tail?: boolean } = { head: true, tail: true },
): { text: string; count: number } {
  const shape = shapeOf(entries);
  const lead = sides.head ? runOf(text, "start") : 0;
  const trail = sides.tail ? runOf(text, "end") : 0;
  if (shape.forms.length === 0 || lead + trail >= text.length) return { text, count: 0 };
  const core = text.slice(lead, text.length - trail);
  const starts = sides.tail ? tailStarts(core, shape) : [];
  let head = 0;
  let headName = "";
  let tail = 0;
  let tailName = "";
  for (const form of shape.forms) {
    if (sides.head) {
      const k = headFragment(form.value, core, budget);
      if (k > head) [head, headName] = [k, form.name];
    }
    if (sides.tail) {
      const t = tailFragment(form.value, core, budget, starts);
      if (t > tail) [tail, tailName] = [t, form.name];
    }
  }
  if (head === 0 && tail === 0) return { text, count: 0 };
  const headSpan = head > 0 ? lead + head : 0;
  const tailSpan = tail > 0 ? trail + tail : 0;
  if (headSpan + tailSpan > text.length)
    return { text: `[SECRET:${head >= tail ? headName : tailName}]`, count: 1 };
  const start = head > 0 ? `[SECRET:${headName}]` : "";
  const end = tail > 0 ? `[SECRET:${tailName}]` : "";
  return {
    text: `${start}${text.slice(headSpan, text.length - tailSpan)}${end}`,
    count: (head > 0 ? 1 : 0) + (tail > 0 ? 1 : 0),
  };
}

/**
 * Pi cuts a tool's output before the redaction sees it. `headCut`: Pi says it dropped the start of the output, so the
 * first line may begin inside a secret. A line that ends in Pi's `... [truncated]` notice lost its end the same way.
 */
export function maskCuts(
  text: string,
  entries: Entries,
  budget: { left: number },
  headCut: boolean,
): { text: string; count: number } {
  let out = text;
  let count = 0;
  if (headCut) {
    const done = maskEdges(out, entries, budget, { head: true });
    out = done.text;
    count += done.count;
  }
  if (!out.includes(TRUNCATED_NOTICE)) return { text: out, count };
  const lines = out.split("\n").map((line) => {
    if (!line.endsWith(TRUNCATED_NOTICE)) return line;
    const done = maskEdges(line.slice(0, -TRUNCATED_NOTICE.length), entries, budget, { tail: true });
    count += done.count;
    return done.text + TRUNCATED_NOTICE;
  });
  return { text: lines.join("\n"), count };
}

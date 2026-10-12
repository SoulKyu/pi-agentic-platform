import type { SecretSet } from "./redact.ts";

const EDGE_MIN = 4;
export const EDGE_WITHHELD_TEXT = "[output hidden: pap-policy could not check its edges]";

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

/** The longest k (EDGE_MIN ≤ k < secret.length) such that `text` ends with the first k characters of `secret`. */
function tailFragment(secret: string, text: string, budget: { left: number }): number {
  for (let k = Math.min(secret.length - 1, text.length); k >= EDGE_MIN; k--) {
    const from = text.length - k;
    let i = 0;
    while (i < k && text.charCodeAt(from + i) === secret.charCodeAt(i)) i++;
    charge(budget, i + 1);
    if (i === k) return k;
  }
  return 0;
}

/** Masks a head or a tail of a live output that a rolling window cut out of a secret (M5R120). Throws past the budget. */
export function maskEdges(
  text: string,
  entries: SecretSet["entries"],
  budget: { left: number },
): { text: string; count: number } {
  let head = 0;
  let headName = "";
  let tail = 0;
  let tailName = "";
  for (const entry of entries) {
    const k = headFragment(entry.value, text, budget);
    if (k > head) [head, headName] = [k, entry.name];
    const t = tailFragment(entry.value, text, budget);
    if (t > tail) [tail, tailName] = [t, entry.name];
  }
  if (head + tail > text.length) tail = 0;
  if (head === 0 && tail === 0) return { text, count: 0 };
  const start = head > 0 ? `[SECRET:${headName}]` : "";
  const end = tail > 0 ? `[SECRET:${tailName}]` : "";
  return {
    text: `${start}${text.slice(head, text.length - tail)}${end}`,
    count: (head > 0 ? 1 : 0) + (tail > 0 ? 1 : 0),
  };
}

import type { ModelSummary } from "@pap/contracts";
import { cutUnits, stripHidden } from "../../../lib/untrusted-text.ts";

export interface PickerModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow?: number;
}

export interface PickerGroup {
  readonly provider: string;
  readonly label: string;
  readonly rows: readonly PickerModel[];
}

/** What a name or a provider label shows at most, in UTF-16 units (MPR26). */
export const NAME_UNITS = 256;

/** A row's identity (React keys, pending marks). Never cleaned: Pi's own ids. Separator-safe: "a/b"+"c" differs from "a"+"b/c". */
export const modelKey = (model: { provider: string; id: string }): string =>
  JSON.stringify([model.provider, model.id]);

/** A name or label as shown: hidden characters removed, then clipped. */
export const shownText = (text: string): string => cutUnits(stripHidden(text), NAME_UNITS);

/** Names are untrusted text (MPR26): clipped to 256 characters and run through `stripHidden`. */
export function toPickerModel(summary: ModelSummary): PickerModel {
  return {
    provider: summary.provider,
    id: summary.id,
    name: shownText(summary.name),
    reasoning: summary.reasoning,
    ...(summary.contextWindow === undefined ? {} : { contextWindow: summary.contextWindow }),
  };
}

const EXACT = 0;
const PREFIX = 1;
const WORD = 2;
const SUBSTRING = 3;
const NONE = 4;

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** How well one lower-cased field matches one lower-cased token. */
function fieldRank(field: string, token: string): number {
  if (field === token) return EXACT;
  const first = field.indexOf(token);
  if (first === -1) return NONE;
  if (first === 0) return PREFIX;
  for (let at = first; at !== -1; at = field.indexOf(token, at + 1))
    if (at === 0 || !isWordChar(field[at - 1])) return WORD;
  return SUBSTRING;
}

interface Entry {
  readonly model: PickerModel;
  readonly score: number;
}

/** The sum of each token's best field rank, or null when a token matches no field. */
function scoreOf(fields: readonly string[], tokens: readonly string[]): number | null {
  let score = 0;
  for (const token of tokens) {
    let best = NONE;
    for (const field of fields) best = Math.min(best, fieldRank(field, token));
    if (best === NONE) return null;
    score += best;
  }
  return score;
}

/**
 * Tokens must all match provider, id or name; ranked exact > prefix > word boundary > substring (a token counts its
 * best field, a row its tokens' sum). Groups keep the source order of their first row, never re-sorted; rows keep it
 * within a group unless a query ranks them. Each model is read once, so the work is linear in the list.
 */
export function groupAndRank(
  models: readonly PickerModel[],
  labels: ReadonlyMap<string, string>,
  query: string,
): PickerGroup[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
  const groups = new Map<string, Entry[]>();
  for (const model of models) {
    const provider = model.provider;
    const score =
      tokens.length === 0
        ? 0
        : scoreOf([provider.toLowerCase(), model.id.toLowerCase(), model.name.toLowerCase()], tokens);
    if (score === null) continue;
    const rows = groups.get(provider);
    if (rows) rows.push({ model, score });
    else groups.set(provider, [{ model, score }]);
  }
  return [...groups].map(([provider, entries]) => ({
    provider,
    label: shownText(labels.get(provider) ?? provider),
    // Array.prototype.sort is stable: rows of the same rank keep the source order.
    rows: (tokens.length === 0 ? entries : entries.toSorted((a, b) => a.score - b.score)).map(
      (entry) => entry.model,
    ),
  }));
}

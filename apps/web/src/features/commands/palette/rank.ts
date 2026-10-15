export type PaletteGroup = "open" | "actions" | "lanes" | "sessions" | "settings";

export interface PaletteItem {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: readonly string[];
  readonly chord?: readonly string[];
  readonly chordJoiner?: "" | "+";
  readonly recency?: number;
  run(): void;
}

const GROUP_ORDER: readonly PaletteGroup[] = ["open", "actions", "lanes", "sessions", "settings"];

export const normalizeSearch = (text: string): string =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function score(item: PaletteItem, tokens: readonly string[]): number | null {
  const terms = item.searchTerms.map(normalizeSearch);
  const joined = terms.join(" ");
  if (!tokens.every((token) => joined.includes(token))) return null;
  const first = tokens[0] ?? "";
  const field = terms.findIndex((term) => term.includes(first));
  const title = normalizeSearch(item.title);
  const bonus = title === tokens.join(" ") ? 3 : title.startsWith(first) ? 2 : title.includes(first) ? 1 : 0;
  return 1000 - 100 * Math.max(field, 0) + bonus;
}

export interface RankedItems {
  groups: Array<{ group: PaletteGroup; items: PaletteItem[] }>;
  /** Every match, including the rows the per-group cap leaves out. */
  count: number;
  actionsOnly: boolean;
}

/** T3 CommandPalette.logic.ts: every token must match; groups keep a fixed order, rows inside one go by score. */
export function rankItems(items: readonly PaletteItem[], query: string, cap = 50): RankedItems {
  const trimmed = query.trim();
  const actionsOnly = trimmed.startsWith(">");
  const tokens = normalizeSearch(actionsOnly ? trimmed.slice(1) : trimmed)
    .split(/\s+/)
    .filter(Boolean);
  const pool = actionsOnly ? items.filter((item) => item.group === "actions") : items;
  const ranked = pool
    .map((item, order) => ({ item, order, score: tokens.length === 0 ? 0 : score(item, tokens) }))
    .filter((entry): entry is { item: PaletteItem; order: number; score: number } => entry.score !== null)
    .sort((a, b) =>
      tokens.length === 0
        ? a.order - b.order
        : b.score - a.score || (b.item.recency ?? 0) - (a.item.recency ?? 0) || a.order - b.order,
    );
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: ranked.filter((entry) => entry.item.group === group).map((entry) => entry.item),
  }))
    .filter((group) => group.items.length > 0)
    .map((group) => ({ ...group, items: group.items.slice(0, cap) }));
  return { groups, count: ranked.length, actionsOnly };
}

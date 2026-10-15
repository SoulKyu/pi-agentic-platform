import type { TranscriptRow } from "@pap/contracts";

export interface EntryLike {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly [field: string]: unknown;
}
/** Pi's entry → messages conversion. Never throws: the reader's converter logs and returns [] for an entry Pi refuses. */
export type Convert = (entry: EntryLike) => unknown[];
export interface IndexedEntries {
  readonly list: readonly EntryLike[];
  readonly byId: ReadonlyMap<string, EntryLike>;
  readonly children: ReadonlyMap<string | null, readonly EntryLike[]>;
  /** Append order: the newest entry under a fork is the one with the highest number. */
  readonly order: ReadonlyMap<string, number>;
  /** Each entry's newest descendant (itself when it has none), computed once in one reverse pass (M2-RT-03). */
  readonly newest: ReadonlyMap<string, EntryLike>;
}
export interface BranchPage {
  readonly rows: TranscriptRow[];
  readonly hasMore: boolean;
  readonly oldestEntryId: string | null;
  readonly turnsBefore: number;
  readonly leafId: string | null;
}
export interface ForkChoice {
  readonly entryId: string;
  readonly preview: string;
  readonly target: string;
  readonly timestamp: string | null;
  readonly onPath: boolean;
}
export interface ForkPoint {
  readonly parentId: string | null;
  readonly choices: ForkChoice[];
}

/** A page never walks more raw entries than this (or 6 per row asked for): tool traffic cannot balloon one page. */
export const MIN_RAW_WINDOW = 200;
const PREVIEW_CHARS = 120;
const TIMESTAMP_CHARS = 64;

export function indexEntries(list: readonly EntryLike[]): IndexedEntries {
  const byId = new Map<string, EntryLike>();
  const children = new Map<string | null, EntryLike[]>();
  const order = new Map<string, number>();
  list.forEach((entry, index) => {
    byId.set(entry.id, entry);
    order.set(entry.id, index);
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  });
  // Children are appended after their parent, so walking the list backwards sees a whole subtree before its root.
  // One pass, one step per entry: a cycle in a damaged file cannot make it loop.
  const newest = new Map<string, EntryLike>();
  for (let index = list.length - 1; index >= 0; index--) {
    const entry = list[index] as EntryLike;
    const candidate = newest.get(entry.id) ?? entry;
    newest.set(entry.id, candidate);
    const parent = entry.parentId;
    if (parent === null || parent === entry.id) continue;
    const current = newest.get(parent);
    if (!current || (order.get(candidate.id) ?? -1) > (order.get(current.id) ?? -1))
      newest.set(parent, candidate);
  }
  return { list, byId, children, order, newest };
}

/** Up the parent chain from `start`, each entry once and at most one step per entry of the file (M2-RT-03). */
function* ancestry(entries: IndexedEntries, start: EntryLike | undefined): Generator<EntryLike> {
  const seen = new Set<string>();
  for (let entry = start; entry && !seen.has(entry.id) && seen.size < entries.list.length;) {
    seen.add(entry.id);
    yield entry;
    entry = entry.parentId ? entries.byId.get(entry.parentId) : undefined;
  }
}

const roleOf = (message: unknown): unknown => (message as { role?: unknown } | null)?.role;

/** What a client shows of one entry: never Pi's system prompt, never a custom message hidden from display. */
export function displayMessages(entry: EntryLike, convert: Convert): unknown[] {
  if (entry.type === "message" && roleOf(entry.message) === "system") return [];
  if (entry.type === "custom_message" && entry.display === false) return [];
  return convert(entry).filter((message) => roleOf(message) !== "system");
}

// The rows a turn starts with: what the minimap numbers (pi-web `isMessageGroupAnchor`).
const isAnchor = (message: unknown): boolean => {
  const role = roleOf(message);
  return role === "user" || role === "compactionSummary" || role === "branchSummary" || role === "custom";
};

const leafOf = (entries: IndexedEntries, leafId: string | null | undefined): EntryLike | undefined =>
  (leafId ? entries.byId.get(leafId) : undefined) ?? entries.list.at(-1);

export function readBranchPage(
  entries: IndexedEntries,
  convert: Convert,
  options: { leafId?: string | null | undefined; before?: string | undefined; limit: number },
): BranchPage {
  const leaf = leafOf(entries, options.leafId);
  const cursor = options.before === undefined ? undefined : entries.byId.get(options.before);
  const start =
    options.before === undefined ? leaf : cursor?.parentId ? entries.byId.get(cursor.parentId) : undefined;
  const chain: EntryLike[] = [];
  const rawCap = Math.max(MIN_RAW_WINDOW, options.limit * 6);
  let visible = 0;
  let hasMore = false;
  let turnsBefore = 0;
  // One bounded walk: the page first, then what is above it (counted, never kept).
  for (const entry of ancestry(entries, start)) {
    if (visible < options.limit && chain.length < rawCap) {
      chain.push(entry);
      visible += displayMessages(entry, convert).length;
      continue;
    }
    const shown = displayMessages(entry, convert);
    if (shown.length > 0) hasMore = true;
    turnsBefore += shown.filter(isAnchor).length;
  }
  const rows = chain
    .toReversed()
    .flatMap((entry) => displayMessages(entry, convert).map((message) => ({ entryId: entry.id, message })));
  return { rows, hasMore, oldestEntryId: chain.at(-1)?.id ?? null, turnsBefore, leafId: leaf?.id ?? null };
}

function previewOf(entry: EntryLike, convert: Convert): string {
  const message = displayMessages(entry, convert)[0] as { content?: unknown; summary?: unknown } | undefined;
  const content = message?.content ?? message?.summary;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (block as { text?: unknown }).text)
            .filter((part) => typeof part === "string")
            .join(" ")
        : "";
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

/** Where the active branch forks, and for each choice the leaf a switch to it goes to: its newest entry. */
export function forkPoints(
  entries: IndexedEntries,
  convert: Convert,
  leafId?: string | null,
  maxPoints = 100,
  maxChoices = 16,
): ForkPoint[] {
  const path = [...ancestry(entries, leafOf(entries, leafId))];
  const onPath = new Set(path.map((entry) => entry.id));
  const points: ForkPoint[] = [];
  for (const parentId of [null, ...path.toReversed().map((entry) => entry.id)]) {
    const kids = entries.children.get(parentId) ?? [];
    if (kids.length < 2) continue;
    points.push({
      parentId,
      choices: kids.slice(0, maxChoices).map((kid) => ({
        entryId: kid.id,
        preview: previewOf(kid, convert),
        target: (entries.newest.get(kid.id) ?? kid).id,
        timestamp: typeof kid.timestamp === "string" ? kid.timestamp.slice(0, TIMESTAMP_CHARS) : null,
        onPath: onPath.has(kid.id),
      })),
    });
    if (points.length >= maxPoints) break;
  }
  return points;
}

export const BRANCH_PATH_MAX = 10_000;
export interface BranchPathEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly user: boolean;
  readonly preview: string;
}

/** The branch that ends at `leafId` (null: the file's last entry), root first; past `max` entries the oldest are dropped. */
export function branchPath(
  entries: IndexedEntries,
  convert: Convert,
  leafId: string | null | undefined,
  max = BRANCH_PATH_MAX,
): { leafId: string | null; entries: BranchPathEntry[] } {
  const leaf = leafOf(entries, leafId);
  const newest: BranchPathEntry[] = [];
  for (const entry of ancestry(entries, leaf)) {
    if (newest.length >= max) break;
    const user = entry.type === "message" && roleOf(entry.message) === "user";
    newest.push({
      id: entry.id,
      parentId: entry.parentId,
      user,
      preview: user ? previewOf(entry, convert) : "",
    });
  }
  return { leafId: leaf?.id ?? null, entries: newest.toReversed() };
}

const NOT_FOUND = { result: null, args: null } as const;

const callOf = (
  message: { content?: unknown } | null,
  toolCallId: string,
): { arguments?: unknown } | undefined =>
  Array.isArray(message?.content)
    ? (message.content.find(
        (block) =>
          (block as { type?: unknown; id?: unknown }).type === "toolCall" &&
          (block as { id?: unknown }).id === toolCallId,
      ) as { arguments?: unknown } | undefined)
    : undefined;

/**
 * The result in this entry and the nearest assistant call before it with the same id: ids repeat across turns, so the
 * entry says which turn is meant. The entry must be a result for that id on the branch (when one is given).
 */
function findCallOfResult(
  entries: IndexedEntries,
  toolCallId: string,
  resultEntryId: string,
  branchLeafId: string | null | undefined,
): { result: unknown | null; args: unknown | null } {
  if (branchLeafId !== undefined) {
    const onBranch = [...ancestry(entries, leafOf(entries, branchLeafId))].some(
      (e) => e.id === resultEntryId,
    );
    if (!onBranch) return NOT_FOUND;
  }
  const entry = entries.byId.get(resultEntryId);
  const result = (entry?.message ?? null) as { role?: unknown; toolCallId?: unknown } | null;
  if (!entry || result?.role !== "toolResult" || result.toolCallId !== toolCallId) return NOT_FOUND;
  const earlier = ancestry(entries, entry.parentId ? entries.byId.get(entry.parentId) : undefined);
  for (const before of earlier) {
    const message = (before.message ?? null) as { role?: unknown; content?: unknown } | null;
    const call = message?.role === "assistant" ? callOf(message, toolCallId) : undefined;
    if (call) return { result, args: call.arguments ?? null };
  }
  return { result, args: null };
}

/**
 * A tool call's arguments and result, newest first. With `branchLeafId` (null: the file's last entry) only the branch
 * that ends there is searched, so a call on an abandoned branch is not found; without it, the whole file.
 */
export function findToolCall(
  entries: IndexedEntries,
  toolCallId: string,
  branchLeafId?: string | null,
  resultEntryId?: string,
): { result: unknown | null; args: unknown | null } {
  if (resultEntryId !== undefined) return findCallOfResult(entries, toolCallId, resultEntryId, branchLeafId);
  let result: unknown | null = null;
  let args: unknown | null = null;
  const candidates =
    branchLeafId === undefined ? entries.list.toReversed() : ancestry(entries, leafOf(entries, branchLeafId));
  for (const entry of candidates) {
    if (result !== null && args !== null) break;
    const message = (entry.message ?? null) as {
      role?: unknown;
      toolCallId?: unknown;
      content?: unknown;
    } | null;
    if (!message) continue;
    if (result === null && message.role === "toolResult" && message.toolCallId === toolCallId)
      result = message;
    if (args === null && message.role === "assistant" && Array.isArray(message.content)) {
      const call = message.content.find(
        (block) =>
          (block as { type?: unknown; id?: unknown }).type === "toolCall" &&
          (block as { id?: unknown }).id === toolCallId,
      ) as { arguments?: unknown } | undefined;
      if (call) args = call.arguments ?? null;
    }
  }
  return { result, args };
}

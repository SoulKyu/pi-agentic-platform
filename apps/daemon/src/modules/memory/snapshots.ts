import { cutUnits } from "../../kernel/text.ts";
import { join } from "node:path";
import { MEM0_LIMITS, type MemoryScope, readSmall, snapshotPath } from "./mem0-files.ts";

/** The watcher wrote `health.json` less than this long ago, or it is stale (M11R146). */
export const HEALTH_STALE_MS = 120_000;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** One entry of a snapshot's `memories` (`{ id, text, createdAt, source }`, pi-mem0's `SnapshotMemory`). */
export interface MemoryItem {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string | null;
  readonly source: string | null;
}
/** One line of an agent snapshot's `events` (pi-mem0's `JournalEvent`, less its ids and scope). */
export interface JournalEntry {
  readonly at: string;
  readonly kind: "add" | "forget";
  readonly text: string;
  readonly source: string;
}

/** A snapshot file as an object; null when it is missing, a link, over 1 MiB or not JSON. Never throws. */
function readObject(path: string | null): Record<string, unknown> | null {
  if (path === null) return null;
  const raw = readSmall(path, MEM0_LIMITS.snapshotBytes);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const clip = (text: string): string => [...text].slice(0, MEM0_LIMITS.textChars).join("");
const stamp = (value: unknown): string | null | undefined =>
  value === undefined ? null : typeof value === "string" && value.length <= 64 ? value : undefined;
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (each): each is Record<string, unknown> =>
          typeof each === "object" && each !== null && !Array.isArray(each),
      )
    : [];

/** The scope's memories, newest first, 200 at most; an item with a wrong field is skipped. Never the store. */
export function readItems(dir: string, scope: MemoryScope): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (const each of objects(readObject(snapshotPath(dir, scope))?.["memories"])) {
    const createdAt = stamp(each["createdAt"]);
    if (typeof each["id"] !== "string" || !ITEM_ID.test(each["id"]) || createdAt === undefined) continue;
    if (typeof each["text"] !== "string" || each["text"].length === 0) continue;
    const source = typeof each["source"] === "string" ? each["source"].slice(0, 64) : null;
    items.push({ id: each["id"], text: clip(each["text"]), createdAt, source });
  }
  return newest(items, (item) => item.createdAt).slice(0, MEM0_LIMITS.items);
}

/** The agent snapshot's `events` (pi-mem0 keeps its newest 100 there), newest first. */
export function readJournal(dir: string, agentId: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const each of objects(readObject(snapshotPath(dir, { kind: "agent", id: agentId }))?.["events"])) {
    const { at, kind, text, source } = each;
    if (typeof at !== "string" || at.length > 64 || (kind !== "add" && kind !== "forget")) continue;
    if (typeof text !== "string" || typeof source !== "string") continue;
    entries.push({ at, kind, text: clip(text), source: source.slice(0, 64) });
  }
  return newest(entries, (entry) => entry.at).slice(0, MEM0_LIMITS.journal);
}

/** Later stamps first; a missing stamp sorts as oldest, and of equal stamps the one later in the file is the newer. */
function newest<T>(list: T[], at: (item: T) => string | null): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (at(b.item) ?? "").localeCompare(at(a.item) ?? "") || b.index - a.index)
    .map(({ item }) => item);
}

/** `scopes/index.json`, `{ projects: { "<id>": { label, cwd } } }`: the id (checked) and its label. The `cwd` is never read out. */
export function readProjects(dir: string): Array<{ id: string; name: string }> {
  const index = readObject(join(dir, "scopes", "index.json"))?.["projects"];
  if (typeof index !== "object" || index === null || Array.isArray(index)) return [];
  const projects: Array<{ id: string; name: string }> = [];
  for (const [id, entry] of Object.entries(index)) {
    if (!PROJECT_ID.test(id) || id.includes("..") || typeof entry !== "object" || entry === null) continue;
    const label = (entry as Record<string, unknown>)["label"];
    projects.push({
      id,
      name: typeof label === "string" && label.trim() !== "" ? label.trim().slice(0, 128) : id,
    });
    if (projects.length >= MEM0_LIMITS.items) break;
  }
  return projects;
}

export interface Health {
  readonly state: "fresh" | "stale" | "unknown";
  readonly checkedAt: number | null;
  /** pi-mem0's last capture failure, clipped to 300 UTF-16 units (the contract's max); null when it wrote none. */
  readonly lastCaptureError: string | null;
  readonly lastCaptureAt: string | null;
}

/** The watcher's heartbeat: `fresh`, `stale` after two minutes, `unknown` when it never wrote a usable one. */
export function readHealth(dir: string, now: number): Health {
  const health = readObject(join(dir, "health.json"));
  const error = health?.["lastCaptureError"];
  const captureAt = health?.["lastCaptureAt"];
  const capture = {
    lastCaptureError: typeof error === "string" && error !== "" ? cutUnits(error, 300) : null,
    lastCaptureAt: typeof captureAt === "string" && captureAt !== "" ? captureAt.slice(0, 64) : null,
  };
  const raw = health?.["watcherAt"];
  const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(at) || at < 0) return { state: "unknown", checkedAt: null, ...capture };
  return { state: now - at <= HEALTH_STALE_MS ? "fresh" : "stale", checkedAt: Math.floor(at), ...capture };
}

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** pi-mem0's layout (its README, "staging contract", "forget request", "save request"): pap reads snapshots and writes requests, never the store. */
export const MEM0_LIMITS = {
  snapshotBytes: 1_048_576,
  factBytes: 16_384,
  items: 200,
  journal: 100,
  staged: 200,
  textChars: 4096,
  forgetIds: 50,
} as const;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const FACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type MemoryScope =
  | { readonly kind: "user" }
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string };

/** The scope as pi-mem0's requests spell it (`user`, `project:<id>`, `agent:<name>`); null for an id pi-mem0 would refuse. */
export function requestScope(scope: MemoryScope): string | null {
  if (scope.kind === "user") return "user";
  if (scope.kind === "project")
    return PROJECT_ID.test(scope.id) && !scope.id.includes("..") ? `project:${scope.id}` : null;
  return AGENT_ID.test(scope.id) ? `agent:${scope.id}` : null;
}

/** Where the scope's snapshot is, inside `dir`; null when the id is not one pi-mem0 writes. */
export function snapshotPath(dir: string, scope: MemoryScope): string | null {
  if (requestScope(scope) === null) return null;
  if (scope.kind === "agent") return join(dir, "agents", `${scope.id}.json`);
  return join(dir, "scopes", scope.kind === "user" ? "user.json" : `project-${scope.id}.json`);
}

/** A regular file of ours, not a link, at most `max` bytes; null when missing or not that. Never throws. */
export function readSmall(path: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > max) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A folder pi-mem0 made under `dir` (a real directory, not a link): created 0700 when `create`. */
function subdir(dir: string, name: "forget" | "save" | "staging", create: boolean): string | null {
  const path = join(dir, name);
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? path : null;
  } catch {
    if (!create) return null;
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
}

/** pi-mem0 drops a forget request over 4 KB and a save request over 8 KB without a word: pap refuses them first. */
const REQUEST_BYTES = { forget: 4096, save: 8192 } as const;

/** One request file, `<uuid>.json`, written 0600 under a temp name and renamed (pi-mem0 claims files by rename). */
function writeRequest(dir: string, name: "forget" | "save", body: Record<string, unknown>): string {
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data, "utf8") > REQUEST_BYTES[name]) throw new Error("mem0: request too large");
  const folder = subdir(dir, name, true);
  if (folder === null) throw new Error("mem0: request folder is not a directory");
  const id = randomUUID();
  const temp = join(folder, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    renameSync(temp, join(folder, `${id}.json`));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return id;
}

export function requestForget(dir: string, scope: MemoryScope, memoryId: string): string {
  const spelled = requestScope(scope);
  if (spelled === null || !MEMORY_ID.test(memoryId)) throw new Error("mem0: bad forget request");
  return writeRequest(dir, "forget", { memoryId, scope: spelled });
}

/**
 * Promote (`replaces` absent) or correct (`replaces` = the memory it replaces, same scope). pi-mem0's contract: `source`
 * is the literal "pi-web" (it drops any other), text 1..4096 UTF-16 units after trim, no `[REDACTED]`.
 */
export function requestSave(dir: string, scope: MemoryScope, text: string, replaces?: string): string {
  const spelled = requestScope(scope);
  const trimmed = text.trim();
  if (
    spelled === null ||
    trimmed.length === 0 ||
    trimmed.length > MEM0_LIMITS.textChars ||
    trimmed.includes("[REDACTED]")
  )
    throw new Error("mem0: bad save request");
  if (replaces !== undefined && !MEMORY_ID.test(replaces)) throw new Error("mem0: bad save request");
  return writeRequest(dir, "save", {
    scope: spelled,
    text: trimmed,
    ...(replaces ? { replaces } : {}),
    source: "pi-web",
  });
}

/**
 * pi-mem0 owns a `.processing` claim for 10 minutes; an older one is abandoned and the owner may decide again. The age is
 * the claim file's mtime, which is the decision file's: pi-mem0 claims by renaming `<id>.decision.json`, and a rename keeps
 * the mtime, so the age counts from the moment the owner decided (pap wrote the decision).
 */
function claimIsFresh(path: string, now: number): boolean {
  try {
    return now - lstatSync(path).mtimeMs <= 10 * 60_000;
  } catch {
    return false; // no claim
  }
}

/** The owner's decision on a staged fact: `<id>.decision.json`, refused while pi-mem0 holds a fresh `.processing` claim. */
export function writeDecision(
  dir: string,
  factId: string,
  approved: boolean,
  now: number,
): "written" | "not_found" | "applying" {
  if (!FACT_ID.test(factId)) return "not_found";
  const staging = subdir(dir, "staging", false);
  if (staging === null || readSmall(join(staging, `${factId}.json`), MEM0_LIMITS.factBytes) === null)
    return "not_found";
  if (claimIsFresh(join(staging, `${factId}.processing`), now)) return "applying";
  const temp = join(staging, `.${factId}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ approved }), { mode: 0o600, flag: "wx" });
    renameSync(temp, join(staging, `${factId}.decision.json`));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return "written";
}

export interface StagedFact {
  readonly id: string;
  readonly agent: string;
  readonly text: string;
  readonly createdAt: string;
  readonly decision: "approved" | "rejected" | null;
  /** pi-mem0 claimed the decision (`<id>.processing`, under 10 minutes old) and is applying the fact. */
  readonly applying: boolean;
}

interface FactBase {
  readonly agent: string;
  readonly text: string;
  readonly createdAt: string;
}

interface CachedBase {
  readonly mtimeMs: number;
  readonly size: number;
  readonly base: FactBase | "skipped";
}

/**
 * What the review tick remembers of the fact files it read: the parsed file, valid while its mtime and size are the
 * same. The decision and the claim are looked at every time. `max` bounds the map (a flooded folder is read, not kept);
 * an entry goes when its file does. `reads` counts the fact files actually read.
 */
export interface StagedCache {
  readonly entries: Map<string, CachedBase>;
  readonly max: number;
  reads: number;
}

export const createStagedCache = (max = 1000): StagedCache => ({ entries: new Map(), max, reads: 0 });

/** The fact file itself, field-checked; null when it is missing, a link or over 16 KB. */
function parseBase(path: string, id: string): FactBase | "skipped" | null {
  const raw = readSmall(path, MEM0_LIMITS.factBytes);
  if (raw === null) return null;
  try {
    const fact = JSON.parse(raw) as Record<string, unknown>;
    if (
      fact.id !== id ||
      typeof fact.agent !== "string" ||
      !AGENT_ID.test(fact.agent) ||
      typeof fact.text !== "string" ||
      typeof fact.createdAt !== "string" ||
      fact.createdAt.length > 64
    )
      return "skipped";
    return {
      agent: fact.agent,
      text: [...fact.text].slice(0, MEM0_LIMITS.textChars).join(""),
      createdAt: fact.createdAt,
    };
  } catch {
    return "skipped";
  }
}

function readBase(staging: string, id: string, cache: StagedCache | undefined): FactBase | "skipped" | null {
  const path = join(staging, `${id}.json`);
  if (cache === undefined) return parseBase(path, id);
  // The stamp is taken before the read: a file that changes in between is read again at the next tick.
  let stamp: { mtimeMs: number; size: number } | null = null;
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // Gone or unreadable: parseBase answers null the same way.
  }
  const hit = stamp === null ? undefined : cache.entries.get(id);
  if (stamp !== null && hit !== undefined && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size)
    return hit.base;
  cache.reads += 1;
  const base = parseBase(path, id);
  if (stamp !== null && base !== null && (cache.entries.has(id) || cache.entries.size < cache.max))
    cache.entries.set(id, { ...stamp, base });
  return base;
}

/** One fact of `staging/`: its file (cached when asked), its decision and its claim; null when missing, "skipped" when unusable. */
function parseFact(
  staging: string,
  id: string,
  now: number,
  cache?: StagedCache,
): StagedFact | null | "skipped" {
  const base = readBase(staging, id, cache);
  if (base === null || base === "skipped") return base;
  try {
    const decisionRaw = readSmall(join(staging, `${id}.decision.json`), 256);
    let decision: StagedFact["decision"] = null;
    if (decisionRaw !== null) {
      const parsed = JSON.parse(decisionRaw) as { approved?: unknown };
      if (typeof parsed.approved === "boolean") decision = parsed.approved ? "approved" : "rejected";
    }
    return { id, ...base, decision, applying: claimIsFresh(join(staging, `${id}.processing`), now) };
  } catch {
    return "skipped";
  }
}

/** One staged fact by id, read from its own file (no window); null when it is not there or not usable. */
export function readStagedFact(dir: string, factId: string, now: number): StagedFact | null {
  if (!FACT_ID.test(factId)) return null;
  const staging = subdir(dir, "staging", false);
  if (staging === null) return null;
  const fact = parseFact(staging, factId, now);
  return fact === null || fact === "skipped" ? null : fact;
}

export interface ListStagedOptions {
  /** Only facts of agents it accepts count toward the cap (the caller's own agents). */
  readonly accept?: (agent: string) => boolean;
  readonly limit?: number;
  /** The clock's now, for the age of a `.processing` claim. */
  readonly now: number;
  /** Incremented for every fact file that was unreadable, over 16 KB or malformed. */
  readonly skipped?: { count: number };
  /** The review tick's: a fact file whose mtime and size are unchanged is not read again. */
  readonly cache?: StagedCache;
}

/**
 * The approval queue, oldest first. The agent filter runs before the cap (200 by default), so facts of other agents
 * or of a deleted agent never hide the caller's own.
 */
export function listStaged(dir: string, options: ListStagedOptions): StagedFact[] {
  const staging = subdir(dir, "staging", false);
  if (staging === null) return [];
  let names: string[];
  try {
    names = readdirSync(staging);
  } catch {
    return [];
  }
  const facts: StagedFact[] = [];
  const { cache } = options;
  if (cache) {
    const present = new Set(names);
    for (const id of cache.entries.keys()) if (!present.has(`${id}.json`)) cache.entries.delete(id);
  }
  for (const name of names) {
    const id = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
    if (id === undefined || !FACT_ID.test(id)) continue;
    const fact = parseFact(staging, id, options.now, cache);
    if (fact === null || fact === "skipped") {
      if (options.skipped) options.skipped.count += 1;
      continue;
    }
    if (options.accept && !options.accept(fact.agent)) continue;
    facts.push(fact);
  }
  return facts
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, options.limit ?? MEM0_LIMITS.staged);
}

/** `PI_MEM0_DIR` when it is an absolute path, else `<Pi agent dir>/mem0` (M11R145); an empty or relative value is said. */
export function mem0Dir(env: NodeJS.ProcessEnv, piAgentDir: string, onRelative?: () => void): string {
  const set = env["PI_MEM0_DIR"];
  if (set === undefined) return join(piAgentDir, "mem0");
  if (isAbsolute(set)) return set;
  onRelative?.();
  return join(piAgentDir, "mem0");
}

/** pi-mem0's folder is there and is a directory. A link to one counts: the path is the owner's choice. */
export function isInstalled(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

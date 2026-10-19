import { Worker } from "node:worker_threads";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Checked, EntryFacts, MirrorRefusal } from "./mirror-line.ts";

export const IDLE_STOP_MS = 60_000;
/** A 32 MiB line parses in well under this; a thread that takes longer is stuck, and the line is refused. */
export const PARSE_TIMEOUT_MS = 30_000;
/** A 32 MiB line parses to a few hundred MiB of objects: the thread has room for it, and its own limit, not the daemon's. */
const THREAD_OLD_GENERATION_MB = 768;

export interface ParseThread {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
}
export type SpawnParseThread = () => ParseThread;

/** The thread file next to this module: TypeScript in the sources, JavaScript in the build. */
export const parseThreadEntry = (moduleUrl: string): URL =>
  new URL(moduleUrl.endsWith(".ts") ? "./mirror-parse-thread.ts" : "./mirror-parse-thread.js", moduleUrl);

const spawnParseThread: SpawnParseThread = () =>
  new Worker(parseThreadEntry(import.meta.url), {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    resourceLimits: { maxOldGenerationSizeMb: THREAD_OLD_GENERATION_MB },
  });

export interface LineParser {
  /** Parses and checks one line (no newline) in the thread, one at a time. Never rejects: a thread that fails refuses the line. */
  parse(line: Buffer, first: boolean): Promise<Checked>;
  stats(): { threadLines: number };
  stop(): Promise<void>;
}

const REFUSED: Checked = { ok: false, reason: "not_json" };

const REASONS: ReadonlySet<string> = new Set<MirrorRefusal>([
  "offset",
  "line_too_large",
  "not_json",
  "not_entry",
  "no_header",
  "duplicate_id",
  "file",
  "quota",
]);

/** What came back from the thread is data from a thread, checked like data: anything but a verdict is a refusal. */
function verdictOf(value: unknown): Checked {
  const checked = value as { ok?: unknown; facts?: Partial<EntryFacts>; reason?: unknown } | null;
  if (checked?.ok === false && typeof checked.reason === "string" && REASONS.has(checked.reason))
    return { ok: false, reason: checked.reason as MirrorRefusal };
  if (checked?.ok === true && checked.facts !== undefined) {
    const { id, userText, headerId } = checked.facts;
    const text = (field: unknown): field is string | null => field === null || typeof field === "string";
    if (text(id) && text(userText) && text(headerId)) return { ok: true, facts: { id, userText, headerId } };
  }
  return REFUSED;
}

/**
 * AVM-E27, AVM-E29: the id the parse gave must be the top-level id the byte scan found; a line where they differ, or
 * where the scan answered nothing usable, is not an entry. The scan of a long line is done in the thread, the compare here.
 */
export function withTopId(checked: Checked, topId: unknown): Checked {
  if (!checked.ok) return checked;
  const own = checked.facts.id ?? checked.facts.headerId;
  return (topId === null || typeof topId === "string") && own === topId
    ? checked
    : { ok: false, reason: "not_entry" };
}

interface Job {
  readonly line: Buffer;
  readonly first: boolean;
  readonly resolve: (checked: Checked) => void;
}

/**
 * One `node:worker_threads` worker for the whole daemon (R32): started at the first line over the inline bound, stopped when
 * idle. Lines go through it one at a time; a thread that dies, answers nonsense or is stopped refuses the line in flight.
 */
export function createLineParser(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly spawn?: SpawnParseThread;
  readonly idleMs?: number;
}): LineParser {
  const spawn = deps.spawn ?? spawnParseThread;
  const idleMs = deps.idleMs ?? IDLE_STOP_MS;
  const queue: Job[] = [];
  let thread: ParseThread | null = null;
  let current: { id: number; job: Job } | null = null;
  let nextId = 1;
  let idle: TimerHandle | null = null;
  let deadline: TimerHandle | null = null;
  let threadLines = 0;
  let stopped = false;

  const clearIdle = (): void => {
    if (idle) deps.clock.clearTimeout(idle);
    idle = null;
  };
  const drop = (): void => {
    const old = thread;
    thread = null;
    if (old) void old.terminate().catch(() => 0);
  };
  const finish = (checked: Checked): void => {
    if (deadline) deps.clock.clearTimeout(deadline);
    deadline = null;
    const done = current;
    current = null;
    done?.job.resolve(checked);
    next();
  };
  const fail = (error: unknown): void => {
    deps.logger.warn("agent_mirror_parse_thread_failed", { err: error });
    drop();
    finish(REFUSED);
  };
  function start(): ParseThread {
    const made = spawn();
    made.unref();
    made.on("message", (message) => {
      const answer = message as { id?: unknown; checked?: unknown; topId?: unknown } | null;
      if (current === null || answer?.id !== current.id) return;
      finish(withTopId(verdictOf(answer.checked), answer.topId));
    });
    made.on("error", (error) => {
      if (thread === made) fail(error);
    });
    made.on("exit", () => {
      if (thread !== made) return;
      thread = null;
      if (current !== null) finish(REFUSED);
    });
    return made;
  }
  function next(): void {
    if (current !== null) return;
    const job = queue.shift();
    if (job === undefined) {
      if (thread !== null && idle === null && !stopped) {
        idle = deps.clock.setTimeout(() => {
          idle = null;
          if (current === null && queue.length === 0) drop();
        }, idleMs);
      }
      return;
    }
    clearIdle();
    try {
      thread ??= start();
      const id = nextId++;
      current = { id, job };
      threadLines++;
      // The thread gets its own copy: the line was a view of a chunk the mirror may still hold.
      const bytes = new Uint8Array(job.line);
      thread.postMessage({ id, bytes, first: job.first }, [bytes.buffer as ArrayBuffer]);
      deadline = deps.clock.setTimeout(() => {
        deadline = null;
        fail(new Error("the parse thread did not answer in time"));
      }, PARSE_TIMEOUT_MS);
    } catch (error) {
      current = null;
      fail(error);
      job.resolve(REFUSED);
    }
  }

  return {
    parse(line, first) {
      if (stopped) return Promise.resolve(REFUSED);
      return new Promise<Checked>((resolve) => {
        queue.push({ line, first, resolve });
        next();
      });
    },
    stats: () => ({ threadLines }),
    async stop() {
      stopped = true;
      clearIdle();
      if (deadline) deps.clock.clearTimeout(deadline);
      deadline = null;
      const pending = [current?.job, ...queue].filter((job): job is Job => job !== undefined);
      current = null;
      queue.length = 0;
      const old = thread;
      thread = null;
      for (const job of pending) job.resolve(REFUSED);
      if (old) await old.terminate().catch(() => 0);
    },
  };
}

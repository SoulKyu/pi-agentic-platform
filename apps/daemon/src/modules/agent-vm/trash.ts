import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentId, PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { papErrorOf, type VmdClient, VmdError } from "./vmd-client.ts";

/** RT-40: a deleted agent's disk (pap-vmd) and mirrors (here) are kept this long. */
export const TRASH_KEEP_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
/** `<agent id>-<stamp>` (the home), `.runs` (its scratch folders), `.mirrors` (a VM agent's transcripts), each with an optional `-<n>`. */
const ENTRY = /^(.+)-(\d{10,16})(\.runs|\.mirrors)?(-\d+)?$/;

export interface TrashDeps {
  /** pap-vmd; null under the process backend, which has no disk of its own to trash. */
  readonly client: VmdClient | null;
  readonly papHome: string;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn" | "info">;
  /** Removes one entry of the trash. The agents module's `removeTree` (which unlocks a scratch folder an agent chmod-ed) in production. */
  readonly remove?: (path: string) => void;
  /** The agent file store's trash (spec 7): purged with "Purge now" and swept with the rest. */
  readonly files?: { purgeTrash(agentId: string): void; sweepTrash(now: number, keepMs: number): void };
}

const trashOf = (papHome: string): string => join(papHome, "agents", ".trash");
const removeEntry = (deps: TrashDeps) =>
  deps.remove ?? ((path: string) => void rmSync(path, { recursive: true, force: true }));

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The trash folder, made 0700 when missing; a link or a file in its place is refused. */
function privateTrash(papHome: string): string {
  const trash = trashOf(papHome);
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const stat = lstatSync(trash);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PapError("internal");
  return trash;
}

/**
 * The VM half of an agent's delete (RT-40): its disk goes to pap-vmd's trash (7 days) and its mirrors to
 * `$PAP_HOME/agents/.trash/<id>-<stamp>.mirrors`. Run again after a failure it finishes the rest: a disk pap-vmd no longer
 * holds, or mirrors already moved, are not errors. The disk goes first, so mirrors never outlive a refused delete.
 */
export async function disposeAgent(deps: TrashDeps, agentId: string, stamp: number): Promise<void> {
  if (!AgentId.safeParse(agentId).success) throw new PapError("bad_request");
  if (deps.client !== null) {
    try {
      await deps.client.request({ op: "disk.delete", agentId, taskKey: null, purge: false });
    } catch (error) {
      if (!(error instanceof VmdError && error.code === "not_found")) throw papErrorOf(error);
    }
  }
  const source = join(deps.papHome, "agents", ".mirrors", agentId);
  if (!exists(source)) return;
  const trash = privateTrash(deps.papHome);
  let target = join(trash, `${agentId}-${stamp}.mirrors`);
  for (let next = 1; exists(target); next += 1) target = join(trash, `${agentId}-${stamp}.mirrors-${next}`);
  renameSync(source, target);
}

/** "Purge now" (RT-40): pap-vmd's trash for the agent, then the mirrors in the daemon's. The home's own trash entry stays its 7 days. */
export async function purgeAgent(deps: TrashDeps, agentId: string): Promise<void> {
  if (!AgentId.safeParse(agentId).success) throw new PapError("bad_request");
  if (deps.client !== null) {
    try {
      await deps.client.request({ op: "trash.purge", agentId });
    } catch (error) {
      throw papErrorOf(error);
    }
  }
  deps.files?.purgeTrash(agentId);
  const trash = trashOf(deps.papHome);
  if (!existsSync(trash)) return;
  const mine = new RegExp(`^${agentId}-\\d{10,16}\\.mirrors(-\\d+)?$`);
  for (const name of readdirSync(trash)) if (mine.test(name)) removeEntry(deps)(join(trash, name));
}

function sweep(deps: TrashDeps): void {
  try {
    deps.files?.sweepTrash(deps.clock.now(), TRASH_KEEP_MS);
  } catch (error) {
    deps.logger.warn("agent_trash_sweep_failed", { err: error });
  }
  const trash = trashOf(deps.papHome);
  let names: string[];
  try {
    names = readdirSync(trash);
  } catch {
    return;
  }
  for (const name of names) {
    const match = ENTRY.exec(name);
    const id = match?.[1];
    if (id === undefined || !AgentId.safeParse(id).success) continue;
    if (deps.clock.now() - Number(match?.[2]) <= TRASH_KEEP_MS) continue;
    try {
      removeEntry(deps)(join(trash, name));
    } catch (error) {
      deps.logger.warn("agent_trash_sweep_failed", { agentId: id, err: error });
    }
  }
}

/** RT-40: at start and once a day, what is older than 7 days leaves `$PAP_HOME/agents/.trash`. Returns the way to stop. */
export function startTrashSweep(deps: TrashDeps): () => void {
  let timer: TimerHandle | null = null;
  const tick = (): void => {
    try {
      sweep(deps);
    } catch (error) {
      deps.logger.warn("agent_trash_sweep_failed", { err: error });
    }
    timer = deps.clock.setTimeout(tick, DAY_MS);
  };
  tick();
  return () => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
}

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  AGENT_LIMITS,
  type AgentRailState,
  AgentId,
  AgentInput,
  type AgentView,
  type Caller,
  PapError,
  type ParamsOf,
  type ResultOf,
  slugOf,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { withDeadline } from "./deadline.ts";
import { checkAgentSave } from "./resources-check.ts";
import { homeExists, HomeMovedRunsLeft, homePath, initHome, makeHome, trashHomeOrFind } from "./homes.ts";
import { changedFields, type ReachDeps, stepUpIfWider } from "./reach.ts";
import type { AgentLinks, AgentVmLink } from "./links.ts";
import { createScratchPort, type ScratchPort } from "./scratch-port.ts";
import { type AgentRecord, createAgentStore } from "./store.ts";
import { type AgentGuard, createAgentGuard } from "./threads.ts";
import { actorOf, pageOf, profileOf, viewOf } from "./view.ts";
import { deleteVmStep } from "./vm-steps.ts";

export interface AgentsDeps extends ReachDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: Pick<AuditPort, "append">;
  /** The kernel runner: the only way pap runs git (M9R11). */
  readonly git: Pick<GitRunner, "run">;
  readonly papHome: string;
  /** Four hex digits of a new id; tests replace it. */
  readonly randomHex?: () => string;
  /** Shared with the thread's open: a delete and an open of one agent never run together (M11R59). */
  readonly guard?: AgentGuard;
  /** The host's ceilings for an agent VM (RT-30); missing: no VM runtime, nothing to check. */
  readonly resourceHost?: () => { memoryCapMb: number; cores: number };
  readonly checkPackages?: (ids: readonly string[]) => Promise<void>; // AVM-E33: an unknown id throws the refusal
  readonly vm?: AgentVmLink; // T15: the VM runtime, `vm` mode only
}

export interface AgentChanged {
  readonly ownerId: string;
  readonly agentId: string;
  readonly removed: boolean;
}

/** What the other modules read of the registry (M11R43). */
export interface AgentsPort extends ScratchPort {
  get(ownerId: string, agentId: string): AgentRecord | null;
  byName(ownerId: string, name: string): AgentRecord | null;
  /** The absolute home folder of an agent of this owner; `not_found` for any other. */
  homeOf(ownerId: string, agentId: string): string;
  list(ownerId: string): AgentRecord[];
  /** The owner of an agent, null for an id that is not one. */
  ownerOf(agentId: string): string | null;
  /** After a create, an edit, a switch or a delete; a throwing listener is logged. Returns the way to stop listening. */
  onChange(listener: (change: AgentChanged) => void): () => void;
  /** The rail state now (M11R62); null for an agent that is not the owner's, and before the rail is bound. */
  state(ownerId: string, agentId: string): AgentRailState | null;
  /** Every agent of the owner is read again and the changed ones reach the `agents` stream (throttled, 250 ms). */
  publish(ownerId: string): void;
  /** A request of an agent opened or closed: the `agents` stream tells it from the row (Task 17). */
  requestChanged(ownerId: string, requestId: string): void;
}

/** What the `agents` stream gives the registry's port, bound once at composition. */
export type AgentRail = Pick<AgentsPort, "state" | "publish" | "requestChanged">;

/** A delete waits this long for the agent's queued tasks to be cancelled; a slower queue fails the delete, retryable. */
export const CANCEL_QUEUED_MS = 10_000;
const ID_TRIES = 8;

const isUnique = (error: unknown): boolean => String((error as Error)?.message).includes("UNIQUE constraint");

export function createAgents(deps: AgentsDeps) {
  const { clock, logger, papHome } = deps;
  const store = createAgentStore(deps.db);
  const listeners = new Set<(change: AgentChanged) => void>();
  /** A resume of an agent with a delete in flight is `session_busy` (M11R183); so is a delete during a thread's open. */
  const { deleting, opening, quarantining } = deps.guard ?? createAgentGuard();
  let links: AgentLinks = deps.vm ? { vm: deps.vm } : {};
  let rail: AgentRail | null = null;

  const owned = (ownerId: string, agentId: string): AgentRecord => {
    const record = store.get(ownerId, agentId);
    if (!record) throw new PapError("not_found");
    return record;
  };

  function notify(ownerId: string, agentId: string, removed: boolean): void {
    for (const listener of listeners) {
      try {
        listener({ ownerId, agentId, removed });
      } catch (error) {
        logger.warn("agent_change_listener_failed", { err: error });
      }
    }
  }

  /** One row per change: the agent id and the names of the changed fields, never the role or a value (M11R49). */
  function audit(caller: Caller, reason: string, agentId: string, fields: readonly string[] | null): void {
    deps.audit.append({
      ownerId: caller.userId,
      ...actorOf(caller),
      kind: "policy",
      reason: `agent ${reason}`,
      detail: { agentId, ...(fields === null ? {} : { fields: fields.join(",") }) },
    });
  }

  const randomHex = deps.randomHex ?? ((): string => randomBytes(2).toString("hex"));

  /** A fresh id and its folder: an id that exists as a row or a folder is skipped, never reused. */
  function newHome(name: string): { id: string; home: string } {
    for (let attempt = 0; attempt < ID_TRIES; attempt += 1) {
      const id = `${slugOf(name)}-${randomHex()}`;
      if (!AgentId.safeParse(id).success || store.exists(id)) continue;
      try {
        return { id, home: makeHome(papHome, id) };
      } catch (error) {
        if (!(error instanceof PapError && error.code === "conflict")) throw error;
      }
    }
    throw new PapError("conflict");
  }

  function removeMade(home: string): void {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      logger.error("agent_home_cleanup_failed", { err: error });
    }
  }

  /** M11R47: the edit applies at the thread worker's next start; a model or thinking change reaches a live thread now. */
  function applyToThread(before: AgentRecord, after: AgentRecord): void {
    const sessionId = after.threadSessionId;
    if (sessionId === null || !links.threads) return;
    try {
      links.threads.releaseIdle(after.ownerId, sessionId);
      const model = JSON.stringify(before.input?.model) !== JSON.stringify(after.input?.model);
      const thinking = before.input?.thinking !== after.input?.thinking;
      if ((model || thinking) && after.input)
        links.threads.applyLive?.(after.ownerId, sessionId, {
          ...(model ? { model: after.input.model } : {}),
          ...(thinking ? { thinking: after.input.thinking } : {}),
        });
    } catch (error) {
      logger.warn("agent_apply_failed", { err: error });
    }
  }

  const busyReason = (record: AgentRecord): boolean =>
    opening.has(record.id) ||
    (record.threadSessionId !== null &&
      (links.threads?.busy(record.ownerId, record.threadSessionId) ?? false)) ||
    (links.automation?.busy(record.ownerId, record.id) ?? false);

  /** A delete that stopped after the home moved: the row is quarantined for good, and the owner's audit trail says so. */
  function leaveIncomplete(caller: Caller, record: AgentRecord, error: unknown): void {
    logger.error("agent_delete_incomplete", { err: error });
    try {
      store.quarantine(record.ownerId, record.id, clock.now());
      audit(caller, "delete incomplete", record.id, null);
    } catch (quarantineError) {
      logger.error("agent_quarantine_failed", { err: quarantineError });
    }
  }

  async function removeSteps(caller: Caller, record: AgentRecord): Promise<string> {
    const { ownerId, id } = record;
    let trashedAs: string;
    try {
      links.automation?.deleteTriggersOf(ownerId, id);
      await withDeadline(
        Promise.resolve(links.automation?.cancelQueuedOf(ownerId, id)),
        clock,
        CANCEL_QUEUED_MS,
      );
      // A warm thread can take a prompt while the queue is cancelled: asked again after the await.
      if (busyReason(record)) throw new PapError("session_busy");
      if (record.threadSessionId !== null) {
        links.threads?.archive(ownerId, record.threadSessionId);
        links.threads?.releaseIdle(ownerId, record.threadSessionId);
      }
      await deleteVmStep(links.vm, id, clock.now(), links.files);
      links.vault?.drop(ownerId, id);
      trashedAs = trashHomeOrFind(papHome, id, clock.now());
    } catch (error) {
      if (error instanceof PapError && error.code === "session_busy") throw error;
      if (error instanceof HomeMovedRunsLeft) leaveIncomplete(caller, record, error);
      else logger.error("agent_delete_failed", { err: error });
      throw new PapError("command_failed");
    }
    try {
      links.onceValues?.drop(ownerId, id);
      store.remove(ownerId, id, clock.now());
      // Its Inbox items (a reply, notifications, delegation results) go with it; the link logs its own failure.
      links.inbox?.removeAgentItems(ownerId, id);
    } catch (error) {
      leaveIncomplete(caller, record, error);
      throw new PapError("command_failed");
    }
    return trashedAs;
  }

  function setPaused(
    ownerId: string,
    agentId: string,
    paused: boolean,
    clearsQuarantine = false,
  ): AgentRecord {
    const record = owned(ownerId, agentId);
    if (!paused && (deleting.has(agentId) || quarantining.has(agentId))) throw new PapError("session_busy");
    if (!paused && record.quarantinedAt !== null && !clearsQuarantine) throw new PapError("conflict");
    // A delete that failed after the home moved leaves the row quarantined for good: nothing to resume (M11R48).
    if (!paused && clearsQuarantine && !homeExists(papHome, agentId)) throw new PapError("conflict");
    if (!paused && record.quarantinedAt !== null) store.resume(ownerId, agentId);
    else store.setPaused(ownerId, agentId, paused);
    notify(ownerId, agentId, false);
    return owned(ownerId, agentId);
  }

  const port: AgentsPort = {
    get: store.get,
    byName: store.byName,
    homeOf(ownerId, agentId) {
      owned(ownerId, agentId);
      return homePath(papHome, agentId);
    },
    list: store.list,
    ownerOf: store.ownerOf,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    state: (ownerId, agentId) => rail?.state(ownerId, agentId) ?? null,
    publish: (ownerId) => rail?.publish(ownerId),
    requestChanged: (ownerId, requestId) => rail?.requestChanged(ownerId, requestId),
    ...createScratchPort(papHome, (ownerId, agentId) => void owned(ownerId, agentId)),
  };

  return {
    /** Merges: each link is bound once, by its own task. Binding one twice is a boot bug, never a silent swap. */
    setLinks(next: AgentLinks): void {
      for (const key of Object.keys(next) as Array<keyof AgentLinks>)
        if (next[key] !== undefined && links[key] !== undefined)
          throw new Error(`agent link ${key} is already bound`);
      // An explicit `{ key: undefined }` binds nothing and unbinds nothing.
      links = {
        ...links,
        ...(Object.fromEntries(Object.entries(next).filter(([, link]) => link !== undefined)) as AgentLinks),
      };
    },

    /** Bound once by the `agents` stream; the registry's port forwards to it. */
    setRail(next: AgentRail): void {
      if (rail) throw new Error("agent rail is already bound");
      rail = next;
    },

    store,
    /** The links as bound now: the `agents` stream reads the facts of the rail through them. */
    links: (): AgentLinks => links,

    list: (caller: Caller): ResultOf<"agents.list"> => pageOf(store.list(caller.userId), logger),

    view: (caller: Caller, agentId: string): AgentView => viewOf(owned(caller.userId, agentId)),

    trash: (caller: Caller) => ({ agents: store.trashed(caller.userId, clock.now()) }),
    async create(caller: Caller, input: AgentInput): Promise<AgentView> {
      stepUpIfWider(deps, caller, null, input, clock.now());
      const ownerId = caller.userId;
      const profile = profileOf(input);
      await checkAgentSave(deps, input, null, logger);
      if (store.count(ownerId) >= AGENT_LIMITS.perOwner) throw new PapError("limit_reached");
      if (store.byName(ownerId, input.name)) throw new PapError("conflict");
      const { id, home } = newHome(input.name);
      try {
        await initHome(deps.git, home, { id, name: input.name });
        // Checked again beside the insert: another create may have finished while git ran.
        store.transaction(() => {
          if (store.count(ownerId) >= AGENT_LIMITS.perOwner) throw new PapError("limit_reached");
          store.insert({ id, ownerId, input, profile, at: clock.now() });
        });
      } catch (error) {
        removeMade(home);
        if (isUnique(error)) throw new PapError("conflict");
        if (!(error instanceof PapError)) logger.error("agent_create_failed", { err: error });
        throw error;
      }
      audit(caller, "created", id, changedFields(null, input));
      notify(ownerId, id, false);
      return viewOf(owned(ownerId, id));
    },

    async update(caller: Caller, params: ParamsOf<"agents.update">): Promise<AgentView> {
      const { agentId, baseRevision, input } = params;
      const before = owned(caller.userId, agentId);
      stepUpIfWider(deps, caller, before.input, input, clock.now());
      if (before.revision !== baseRevision) throw new PapError("conflict");
      const profile = profileOf(input);
      await checkAgentSave(deps, input, before.input, logger);
      const taken = store.byName(caller.userId, input.name);
      if (taken && taken.id !== agentId) throw new PapError("conflict");
      const fields = changedFields(before.input, input);
      if (before.input !== null && fields.length === 0) return viewOf(before);
      let changed: boolean;
      try {
        changed = store.update(caller.userId, agentId, baseRevision, {
          name: input.name,
          profile,
          at: clock.now(),
        });
      } catch (error) {
        throw isUnique(error) ? new PapError("conflict") : error;
      }
      if (!changed) throw new PapError("conflict");
      const after = owned(caller.userId, agentId);
      audit(caller, "updated", agentId, fields);
      notify(caller.userId, agentId, false);
      applyToThread(before, after);
      return viewOf(after);
    },

    /**
     * Pauses first, then checks (M11R183): the runner's admission reads `paused` and marks a task running in one step, so
     * a task admitted before the pause is seen here and none is admitted after it.
     */
    async remove(caller: Caller, agentId: string): Promise<ResultOf<"agents.delete">> {
      deps.requireStepUp(caller, clock.now());
      const record = owned(caller.userId, agentId);
      if (deleting.has(agentId)) throw new PapError("session_busy");
      deleting.add(agentId);
      try {
        store.setPaused(record.ownerId, agentId, true);
        let busy: boolean;
        try {
          busy = busyReason(record);
        } catch (error) {
          store.setPaused(record.ownerId, agentId, record.paused);
          throw error;
        }
        if (busy) {
          store.setPaused(record.ownerId, agentId, record.paused);
          throw new PapError("session_busy");
        }
        let trashedAs: string;
        try {
          trashedAs = await removeSteps(caller, record);
        } catch (error) {
          // Busy again after the await: the agent goes back to the switch it had; a retry finds the rest done.
          if (error instanceof PapError && error.code === "session_busy")
            store.setPaused(record.ownerId, agentId, record.paused);
          throw error;
        }
        audit(caller, "deleted", agentId, null);
        notify(record.ownerId, agentId, true);
        return { trashedAs };
      } finally {
        deleting.delete(agentId);
      }
    },

    /** `agents.setPaused` (M11R75): the switch, answered as the owner's view of the agent. */
    pause(caller: Caller, agentId: string, paused: boolean): AgentView {
      // A resume also clears a quarantine (M11R115), and that asks for the password: the incident is over only on the owner's word.
      const quarantined = !paused && owned(caller.userId, agentId).quarantinedAt !== null;
      if (quarantined) deps.requireStepUp(caller, clock.now());
      const record = setPaused(caller.userId, agentId, paused, quarantined);
      if (!paused) links.vm?.resume(agentId);
      // One row per switch, whoever flips it: the agent id only (M11R49).
      audit(caller, paused ? "paused" : quarantined ? "resumed from quarantine" : "resumed", agentId, null);
      return viewOf(record);
    },

    /** Pausing is always allowed. A resume is refused while a delete or a quarantine of the agent is running, and for a quarantined one (`pause` clears that after the password). */
    setPaused,

    port,
  };
}
export type Agents = ReturnType<typeof createAgents>;

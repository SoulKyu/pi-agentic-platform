import type { AgentInput, Caller, SecretEntry, TaskView, TriggerView } from "@pap/contracts";

/** What the agents module asks of the VM runtime (absent in a bed that composes no VM stack). */
export interface AgentVmLink {
  /** `sandbox_unavailable` when the VM stack is unusable: an agent is not created on a machine that cannot run it. */
  require(): Promise<void>;
  /** Stops every VM of the agent (its own and its isolated tasks'), revoking their launches; the disk stays (RT-41). */
  stop(agentId: string): Promise<void>;
  /** A delete: the disk to pap-vmd's trash and the mirrors to the daemon's, named by `stamp` (7 days, RT-40). Safe to repeat. */
  dispose(agentId: string, stamp: number): Promise<void>;
  /** "Purge now": the agent's entries leave pap-vmd's trash and the mirrors' trash at once. */
  purge(agentId: string): Promise<void>;
  /** The owner's Resume: the VM runtime forgets the agent's crashes (T7: only this caller). */
  resume(agentId: string): void;
}

/**
 * What the agents module asks of the modules around it, bound late (`setLinks`) because they are built after it or by
 * later tasks. Every link is optional: an absent one is a step that has nothing to do yet (Task 9's thread, Task 10's
 * triggers and tasks, Task 13's vault, Task 18's use-once values). A link that throws is handled where it is called.
 */
export interface AgentLinks {
  /** The agent's long-lived thread (a session of the sessions module). */
  readonly threads?: {
    /** The thread is running, or a prompt or reopen is in flight (M11R183: delete refuses while it is). */
    busy(ownerId: string, sessionId: string): boolean;
    /** M4's archive mark (reversible, Undo in the archived list). */
    archive(ownerId: string, sessionId: string): void;
    /** M9's `releaseIdle` (M11R47): an edit applies at the worker's next start; a running thread keeps its profile. */
    releaseIdle(ownerId: string, sessionId: string): void;
    /** Stops the run in progress, if any (quarantine, M11R115); a session that is gone is nothing to abort. */
    abort?(ownerId: string, sessionId: string): Promise<void>;
    /** A model or thinking change reaches a live thread at once (`set_model`, `set_thinking_level`). */
    applyLive?(
      ownerId: string,
      sessionId: string,
      change: { readonly model?: AgentInput["model"]; readonly thinking?: AgentInput["thinking"] },
    ): void;
  };
  /** M10's automation module: the agent's triggers and tasks. */
  readonly automation?: {
    /** A task of the agent is running or starting (M11R183). */
    busy(ownerId: string, agentId: string): boolean;
    /** The agent's triggers with their secret files (M10's delete path). */
    deleteTriggersOf(ownerId: string, agentId: string): void;
    cancelQueuedOf(ownerId: string, agentId: string): void | Promise<void>;
    /** Cancels the agent's running, waiting and queued tasks, M10's cancel path; how many were cancelled (quarantine, M11R115). */
    cancelAllOf?(ownerId: string, agentId: string): Promise<number>;
    /**
     * New secrets for the agent's webhook triggers (quarantine: the step-up was given for the whole command). A trigger that
     * could not be rotated is named in `failed`; the ones that were are in `secrets`, shown once.
     */
    rotateSecretsOf?(
      caller: Caller,
      agentId: string,
    ): {
      readonly secrets: ReadonlyArray<{
        readonly triggerId: string;
        readonly name: string;
        readonly secret: string;
      }>;
      readonly failed: readonly string[];
    };
    /** A thread task the owner queued (M11R77): its id; `agent_paused` for a quarantined agent, `rate_limited` for a full queue. */
    queueTask?(input: {
      readonly ownerId: string;
      readonly agentId: string;
      readonly prompt: string;
      readonly handOff: { readonly fromName: string; readonly quote: string } | null;
    }): { taskId: string };
    /** The agent's newest tasks and its triggers, as the caller may see them (M11R76). */
    statusOf?(caller: Caller, agentId: string): { tasks: TaskView[]; triggers: TriggerView[] };
  };
  /** Quarantine step 2 (M11R139 d): the agent's running children are aborted; how many. */
  readonly subagents?: { cancelAllOf(ownerId: string, agentId: string): number };
  /** What the rail reads beyond the thread and the requests (M11R62): Task 11's cards, Task 30's children. */
  readonly rail?: {
    /** The newest unread event card of the agent says failed. */
    failedCard(ownerId: string, agentId: string): boolean;
    /** A child of the agent's thread waits for the owner. */
    childWaiting(ownerId: string, agentId: string): boolean;
  };
  /**
   * The Inbox, bound once (Task 12; Task 17's half joins this bind at J3). `clearReply` closes the agent's `agent_reply` item (read and resolved, W5-R48)
   * on a reset of its thread; `removeAgentItems` drops every item the agent carries when it is deleted.
   */
  readonly inbox?: {
    clearReply(ownerId: string, agentId: string): void;
    removeAgentItems(ownerId: string, agentId: string): void;
  };
  /** The agent's vault scope, dropped before its home moves (Task 13). */
  readonly vault?: {
    drop(ownerId: string, agentId: string): void;
    /** The names in the agent's vault, never a value (the sheet and quarantine list them). */
    list?(caller: Caller, agentId: string): { entries: SecretEntry[]; state: "ok" | "unreadable" };
  };
  /** The agent's imported files (spec 7): their paths, listed by quarantine, and their folder, sent to the trash by a delete. */
  readonly files?: {
    paths(ownerId: string, agentId: string): string[];
    dispose(agentId: string, stamp: number): void;
  };
  /** The agent's pending requests, closed as cancelled when it is quarantined (Task 17). */
  readonly requests?: { cancelAllOf(ownerId: string, agentId: string): number };
  /** The "use once" values still waiting for the agent (Task 18). */
  readonly onceValues?: { drop(ownerId: string, agentId: string): void };
  /** The VM runtime (T15): given to `createAgents` in `vm` mode. */
  readonly vm?: AgentVmLink;
}

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ApprovalMode, PapError } from "@pap/contracts";
import type { AgentSurface } from "./agent-surface.ts";
import { type ChildSource, createChildren } from "./children.ts";
import type { LiveSession } from "./live-session.ts";
import type { MarksStore } from "./marks-store.ts";
import type { SessionsServiceDeps } from "./service-types.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow } from "./store.ts";

/** A new child's policy while its row is not stored: the first init reads it (like a task's, but the child is not unattended). */
export interface ChildSessionPolicy {
  readonly mode: ApprovalMode;
  /** The profile's list narrowed to the parent's preset; null: the profile names none and the parent's preset alone limits it. */
  readonly tools: readonly string[] | null;
  readonly tainted: boolean;
  /** The profile's prompt, appended to the system prompt at every start of this daemon's life. */
  readonly prompt: string | null;
}

/** What the subagents module resolved of a profile (Task 29b): the file's own words, not yet narrowed. */
export interface ChildProfile {
  readonly tools: readonly string[] | null;
  readonly prompt: string | null;
  readonly model: string | null;
}

export interface SessionsChildPort {
  /** A child would not be refused for capacity now: a worker stays free for the owner and the memory floor holds (M10R154). */
  admits(ownerId: string): boolean;
  /**
   * The parent's folder, the profile's tools narrowed to the parent's preset (`bad_request` when none is left), the parent's
   * mode (`full-access` becomes `auto-accept-edits`), the parent's taint, the profile's model or the parent's. A child of an
   * agent thread keeps the agent (role `child`). `not_found` (not the owner's parent), `bad_request` (a parent that is a child,
   * a task or an agent's isolated session), then `capacity`, `disk_low`, the launch gate's codes and `worker_failed`.
   */
  createChildSession(input: {
    ownerId: string;
    parentSessionId: string;
    profile?: ChildProfile | null;
  }): Promise<{ sessionId: string; tainted: boolean }>;
  /** The last assistant text of the owner's child session, cut to `max` characters; null when there is none. */
  lastText(ownerId: string, sessionId: string, max: number): Promise<string | null>;
  /** The session is the owner's and not archived: a child is not made for a parent that is gone. */
  parentOpen(ownerId: string, parentSessionId: string): boolean;
  /** Where the parent's screen reads its children from: the subagents module binds it once (M11R140). */
  setSource(source: ChildSource): void;
  /** The parent's stream and sidebar line hear that its children changed (a new one, an ending). */
  refresh(parentSessionId: string): void;
  /** A child of the session waits for an answer: the parent needs input (M10's attention). */
  waiting(sessionId: string): boolean;
  /** A child of the owner's agent waits for an answer: the agent's rail shows `needs input`. */
  waitingAgent(ownerId: string, agentId: string): boolean;
  /** A session was archived or deleted (M11R139 c): a parent's running children are aborted. The listener is removed by the result. */
  onGone(listener: (sessionId: string, why: "archived" | "deleted") => void): () => void;
  /** Removes the prompt files that no session row has (W5-R62); how many. Boot only. */
  sweepPrompts(): number;
}

const MAX_LIST = 32;
const MAX_PROMPT = 32_768;

/** What the parent's worker last said of its active tools (`getActiveToolNames`): the loadout. */
export interface ActiveTools {
  readonly tools: readonly string[];
  readonly toolsTruncated: boolean;
}

/**
 * M11R136, review I1: the profile's list narrowed to the tools the parent's worker has ACTIVE, whatever its preset (a
 * `configured` parent's tools are Pi's own and not a table). Fail closed: with no loadout nothing is known, so no tool is kept
 * (an empty result is refused); with a cut loadout only the names in its known prefix are kept.
 */
export function narrowTools(tools: readonly string[], active: ActiveTools | null): string[] {
  const known = new Set(active?.tools ?? []);
  return [...new Set(tools.filter((name) => known.has(name)))].slice(0, MAX_LIST);
}

/** The rules of a new child before its policy row exists: its parent's mode and taint, a list when it has one, attended. */
export const childRules = (child: ChildSessionPolicy) => ({
  approvalMode: child.mode,
  taint: { tainted: child.tainted, epoch: 0 },
  toolAllowlist: child.tools && [...child.tools],
  unattended: false,
});

/** In the transaction that stores a new child's row: its policy, with the parent's taint (sticky). */
export function storeChildPolicy(deps: Pick<SessionsServiceDeps, "policy" | "clock">, row: SessionRow): void {
  const { child } = row;
  if (child)
    deps.policy.setChildPolicy(row.ownerId, row.id, {
      mode: child.mode,
      tools: child.tools,
      taintedAt: child.tainted ? deps.clock.now() : null,
    });
}

/** A child is never more trusted than a person watching it, and nobody watches it directly (M11R136). */
export const childModeOf = (parent: ApprovalMode): ApprovalMode =>
  parent === "full-access" ? "auto-accept-edits" : parent;

export interface ChildPortContext {
  readonly deps: SessionsServiceDeps;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly agent: AgentSurface;
  readonly keepFreeFor: Set<string>;
  keepOneFree(): void;
  launch(row: SessionRow, isNew: boolean): Promise<LiveSession>;
  /** The mode in force for the parent session (an agent thread's effective mode). */
  modeOf(row: SessionRow): ApprovalMode;
  readonly lastText: (sessionId: string, max: number) => Promise<string | null>;
  /** The sidebar and the project counts after a new session. */
  readonly publisher: Pick<ShellPublisher, "changed" | "projectChanged">;
  readonly marks: Pick<MarksStore, "row">;
}

/** The model of a profile's text: `provider/id`, or an id of the parent's provider. */
function modelOf(
  text: string | null,
  parent: { provider: string; id: string } | null,
): { provider: string; modelId: string } | null {
  if (text !== null) {
    const slash = text.indexOf("/");
    if (slash > 0) return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
    return parent ? { provider: parent.provider, modelId: text } : null;
  }
  return parent ? { provider: parent.provider, modelId: parent.id } : null;
}

/** What the sessions service itself calls on the port beyond what the subagents module may. */
export interface ChildPortInternals {
  promptOf(row: SessionRow): string | undefined;
  /** Every event a session publishes (a child's dialogs and state reach its parent's stream). */
  published(sessionId: string, event: { readonly kind: string }): void;
  /** The children as the parent's snapshot carries them. */
  viewsOf: ReturnType<typeof createChildren>["viewsOf"];
  /** The session was archived: its running children stop, and its host grants go (W5-R52). */
  archived(sessionId: string): void;
  /** The session row was deleted: a child's prompt file goes with it (an archive is reversible, a delete is not). */
  removed(row: SessionRow): void;
}

export function createChildPort(ctx: ChildPortContext): SessionsChildPort & ChildPortInternals {
  const { deps, live } = ctx;
  const children = createChildren({
    store: deps.store,
    live,
    hub: deps.hub,
    publisher: ctx.publisher,
    logger: deps.logger,
  });
  const gone = new Set<(sessionId: string, why: "archived" | "deleted") => void>();
  const notifyGone = (sessionId: string, why: "archived" | "deleted"): void => {
    for (const listener of [...gone]) {
      try {
        listener(sessionId, why);
      } catch (error) {
        deps.logger.warn("child_gone_listener_failed", { sessionId, err: error });
      }
    }
  };
  // W5-R62: a child's profile prompt is a 0600 file under a 0700 folder, written before its row and read at every start.
  const folder = join(deps.worker.papHome, "subagents");
  const fileOf = (id: string) => join(folder, `${id}.prompt`);
  const dropPrompt = (id: string) => {
    try {
      rmSync(fileOf(id), { force: true });
    } catch (error) {
      deps.logger.warn("child_prompt_not_removed", { sessionId: id, err: error });
    }
  };
  return {
    ...children,
    refresh: children.changed,
    onGone(listener) {
      gone.add(listener);
      return () => void gone.delete(listener);
    },
    archived(sessionId) {
      ctx.agent.hostGrants.drop(sessionId);
      notifyGone(sessionId, "archived");
    },
    removed(row) {
      if (row.parentSessionId !== undefined) dropPrompt(row.id);
      notifyGone(row.id, "deleted");
    },
    parentOpen(ownerId, parentSessionId) {
      const row = deps.store.get(parentSessionId);
      return row?.ownerId === ownerId && ctx.marks.row(parentSessionId)?.marks.archivedAt == null;
    },
    sweepPrompts() {
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          deps.logger.warn("child_prompts_not_listed", { err: error });
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        const id = name.endsWith(".prompt") ? name.slice(0, -".prompt".length) : null;
        if (id === null || deps.store.get(id)) continue;
        dropPrompt(id);
        removed += 1;
      }
      return removed;
    },
    promptOf(row) {
      if (row.child) return row.child.prompt || undefined;
      if (row.parentSessionId === undefined) return undefined;
      try {
        return readFileSync(fileOf(row.id), "utf8").slice(0, MAX_PROMPT) || undefined;
      } catch (error) {
        // The child still starts: its limits come from the database. Only the profile's words are lost.
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        deps.logger.warn(missing ? "child_prompt_missing" : "child_prompt_unreadable", { sessionId: row.id });
        return undefined;
      }
    },
    admits() {
      if (deps.freeMemMb() < deps.limits.minFreeMemMb) return false;
      try {
        ctx.keepOneFree();
        return true;
      } catch (error) {
        if (error instanceof PapError && error.code === "capacity") return false;
        throw error;
      }
    },
    async createChildSession({ ownerId, parentSessionId, profile }) {
      const parent = deps.store.get(parentSessionId);
      if (!parent || parent.ownerId !== ownerId) throw new PapError("not_found");
      const type = ctx.agent.kindOf(parentSessionId)?.type;
      if (type !== "plain" && type !== "lane" && type !== "agent-thread") throw new PapError("bad_request");
      const preset = deps.store.toolPreset(parentSessionId);
      const listed = profile?.tools ?? null;
      const tools =
        listed === null ? null : narrowTools(listed, live.get(parentSessionId)?.loadout() ?? null);
      if (tools !== null && tools.length === 0) throw new PapError("bad_request");
      const tainted = deps.policy.sessionPolicy(ownerId, parentSessionId).taint.tainted;
      const prompt = profile?.prompt ? profile.prompt.slice(0, MAX_PROMPT) : null;
      deps.admission?.task();
      // Checked again inside `launch`, after the gate; here a full pool answers before the gate opens anything.
      ctx.keepOneFree();
      const now = deps.clock.now();
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd: parent.cwd,
        ownerId,
        name: null,
        createdAt: now,
        updatedAt: now,
        ...(preset ? { toolPreset: preset } : {}),
        parentSessionId,
        // A child of an agent thread keeps the agent: its gate, its rules and its budget are the agent's (M11R35).
        ...(parent.agentId !== undefined ? { agentId: parent.agentId, agentRole: "child" as const } : {}),
        child: { mode: childModeOf(ctx.modeOf(parent)), tools, tainted, prompt },
      };
      // Always written, empty when the profile has no prompt, so that a missing file at a reopen means a lost one.
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        // A folder that existed with another mode is made private again, as an agent's home is.
        chmodSync(folder, 0o700);
        writeFileSync(fileOf(row.id), prompt ?? "", { mode: 0o600, flag: "wx" });
        chmodSync(fileOf(row.id), 0o600);
      } catch (error) {
        deps.logger.warn("child_prompt_not_written", { sessionId: row.id, err: error });
        dropPrompt(row.id);
        throw new PapError("internal");
      }
      ctx.keepFreeFor.add(row.id);
      let session: LiveSession;
      try {
        session = await ctx.launch(row, true);
      } catch (error) {
        dropPrompt(row.id);
        throw error;
      } finally {
        ctx.keepFreeFor.delete(row.id);
      }
      const parentModel = live.get(parentSessionId)?.loadout()?.model ?? null;
      const wanted = modelOf(profile?.model ?? null, parentModel);
      if (wanted !== null) {
        // A model the runtime does not offer keeps Pi's default; it never fails the child (the agent profile's rule).
        const report = () => deps.logger.warn("child_model_not_applied", { sessionId: row.id });
        await session
          .command({ type: "set_model", provider: wanted.provider, modelId: wanted.modelId })
          .then((answer) => void (answer.ok || report()), report);
      }
      ctx.publisher.changed(row.id);
      ctx.publisher.projectChanged(ownerId, ctx.marks.row(row.id)?.projectId ?? null);
      return { sessionId: row.id, tainted };
    },
    async lastText(ownerId, sessionId, max) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId || row.parentSessionId === undefined) return null;
      return ctx.lastText(sessionId, max);
    },
  };
}

import {
  applyMark,
  type MarkChange,
  markStateOf,
  type Marks,
  type MarkState,
  type ProjectChange,
  type ProjectSummary,
  type ShellSession,
} from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import type { Timers } from "../../runtime/connection.ts";
import { pinnedIds } from "../../stores/shell-reducer.ts";
import type { useShellStore } from "../../stores/shell-store.ts";

export type ShellStoreApi = Pick<typeof useShellStore, "getState" | "subscribe">;
export type Outcome = { result: "ok" | "busy" | "refused" | "unknown"; code?: string; undo?: MarkState };

export interface OrganiseDeps {
  readonly rpc: Runtime["rpc"];
  readonly store: ShellStoreApi;
  /** Asks the `shell` stream for a fresh snapshot (`subscriptions.resync("shell", "me")`). */
  resync(): void;
  /** The Undo wait's timer; the page's own `setTimeout` when absent. */
  readonly timers?: Timers;
}

/** How long an Undo waits for another change to be saved before it says so (M4R97). */
export const UNDO_WAIT_MS = 2_000;

const pageTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

export const marksOf = (session: ShellSession): Marks => ({
  pinRank: session.pinRank,
  archivedAt: session.archivedAt,
  settledAt: session.settledAt,
  // Not on the wire: an automatic settle shows like a manual one; the daemon keeps the difference.
  settledAuto: false,
  unsettledAt: null,
  snoozedUntil: session.snoozedUntil,
});

const codeOf = (error: unknown): string => (error instanceof RpcError ? error.code : "internal");
const unknownOutcome = (code: string): boolean => code === "connection_lost" || code === "timeout";

/** The answer of a mutation shown before it came (M4R96): confirmed, rolled back, or read back from a snapshot. */
async function settle(commandId: string, send: () => Promise<unknown>, deps: OrganiseDeps): Promise<Outcome> {
  try {
    await send();
    deps.store.getState().confirm(commandId);
    return { result: "ok" };
  } catch (error) {
    const code = codeOf(error);
    if (unknownOutcome(code)) {
      // Sent, not answered: the sidebar is freed now and a fresh snapshot says what happened (M4R83, R105, RT-03).
      deps.store.getState().confirm(commandId);
      deps.resync();
      return { result: "unknown", code };
    }
    deps.store.getState().rollback(commandId);
    return { result: "refused", code };
  }
}

/** One filing action, shown before the answer (M4R96), at most one at a time (M4R83). */
export async function organise(
  input: { readonly session: ShellSession; readonly change: MarkChange; readonly now: number },
  deps: OrganiseDeps,
): Promise<Outcome> {
  const view = deps.store.getState().view;
  if (view.pending.size > 0) return { result: "busy" };
  const pins = pinnedIds(view);
  const outcome = applyMark(input.session.id, marksOf(input.session), input.change, pins, input.now);
  if (!outcome.ok) return { result: "refused", code: outcome.code };
  const captured = markStateOf(input.session.id, marksOf(input.session), pins, input.now);
  const after: ShellSession = {
    ...input.session,
    pinRank: outcome.marks.pinRank,
    archivedAt: outcome.marks.archivedAt,
    settledAt: outcome.marks.settledAt,
    snoozedUntil: outcome.marks.snoozedUntil,
  };
  // The other pins whose rank moves with this one (a pin, an unpin, an archive of a pinned session).
  const moved = (outcome.pins ?? []).flatMap((id, index) => {
    const other = view.sessions.get(id);
    return other && id !== input.session.id && other.pinRank !== index + 1
      ? [{ ...other, pinRank: index + 1 }]
      : [];
  });
  const commandId = deps.rpc.newCommandId();
  deps.store.getState().optimistic(commandId, { sessions: [after, ...moved] });
  const settled = await settle(
    commandId,
    () =>
      deps.rpc.call("sessions.mark", { sessionId: input.session.id, change: input.change }, { commandId }),
    deps,
  );
  return settled.result === "ok" ? { result: "ok", undo: captured } : settled;
}

/** Resolves true once no change is pending, false after `ms` (M4R97). */
function whenIdle(store: ShellStoreApi, timers: Timers, ms: number): Promise<boolean> {
  if (store.getState().view.pending.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let off = (): void => {};
    const timer = timers.set(() => {
      off();
      resolve(false);
    }, ms);
    off = store.subscribe((state) => {
      if (state.view.pending.size > 0) return;
      timers.clear(timer);
      off();
      resolve(true);
    });
  });
}

/** Undo from a toast (M4R97): a `restore`, sent like any change; behind another change it waits for it once. */
export async function undo(
  input: { readonly sessionId: string; readonly state: MarkState; now(): number },
  deps: OrganiseDeps,
): Promise<Outcome> {
  const attempt = (): Promise<Outcome> => {
    const session = deps.store.getState().view.sessions.get(input.sessionId);
    if (!session) return Promise.resolve({ result: "refused", code: "not_found" });
    return organise({ session, change: { kind: "restore", state: input.state }, now: input.now() }, deps);
  };
  const first = await attempt();
  if (first.result !== "busy") return first;
  return (await whenIdle(deps.store, deps.timers ?? pageTimers, UNDO_WAIT_MS)) ? attempt() : first;
}

/** The daemon's placement (M4R21) for the shown order: between the neighbours, or last + 1. */
function positionBefore(order: readonly ProjectSummary[], id: string, before: string | null): number {
  const rest = order.filter((project) => project.id !== id);
  const at = before === null ? -1 : rest.findIndex((project) => project.id === before);
  if (at === -1) return (rest.at(-1)?.position ?? 0) + 1;
  const next = rest[at] as ProjectSummary;
  const previous = rest[at - 1];
  return previous ? (previous.position + next.position) / 2 : next.position - 1;
}

/** Rename or move a project, shown before the answer like a session's change. */
export async function organiseProject(
  input: {
    readonly project: ProjectSummary;
    readonly change: ProjectChange;
    readonly order: readonly ProjectSummary[];
  },
  deps: OrganiseDeps,
): Promise<Outcome> {
  if (deps.store.getState().view.pending.size > 0) return { result: "busy" };
  const after: ProjectSummary =
    input.change.kind === "rename"
      ? { ...input.project, name: input.change.name.trim() }
      : { ...input.project, position: positionBefore(input.order, input.project.id, input.change.before) };
  const commandId = deps.rpc.newCommandId();
  deps.store.getState().optimistic(commandId, { projects: [after] });
  return settle(
    commandId,
    () =>
      deps.rpc.call("projects.update", { projectId: input.project.id, change: input.change }, { commandId }),
    deps,
  );
}

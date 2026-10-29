import {
  type BoxRef,
  boxKey,
  type GuestReport,
  PapError,
  type PreviewsEvent,
  type PreviewView,
  SERVICE_LIMITS,
  type ServiceView,
} from "@pap/contracts";
import type { BoxOps } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PreviewTokens } from "./tokens.ts";

/** What the registry reads of a guest link: the reports of its services and the end of the link. */
export interface RegistryLink {
  /** Every `service` report the guest sends, until the returned function is called. */
  onServiceReport(listener: (report: Extract<GuestReport, { type: "service" }>) => void): () => void;
  readonly closed: Promise<void>;
}

/** What the registry reads of the VM runtime (`AgentRuntime` satisfies it). */
export interface RegistryRuntime {
  onPhase(listener: (box: BoxRef, phase: "stopped" | "starting" | "running") => void): () => void;
  link(box: BoxRef): RegistryLink | undefined;
  phase(box: BoxRef): string;
}

export interface ServiceSpec {
  readonly name: string;
  readonly command: string;
  readonly port: number;
  readonly network: boolean;
}

export interface PreviewRegistry {
  /** `limit_reached` before the guest is asked when the box already runs 4; `box_stopped` when it is not running. */
  start(box: BoxRef, ownerId: string, spec: ServiceSpec, signal?: AbortSignal): Promise<ServiceView>;
  /** False when there was nothing to stop (an unknown name asks nothing). */
  stop(box: BoxRef, name: string): Promise<boolean>;
  restart(box: BoxRef, name: string): Promise<ServiceView>;
  /** What the registry holds of the box now (no guest call). */
  list(box: BoxRef): readonly ServiceView[];
  /** The guest's own list, asked without waking the box, reconciled into the registry. */
  refresh(box: BoxRef): Promise<readonly ServiceView[]>;
  /** The owner's services in all their boxes, at most 256. */
  all(ownerId: string): readonly PreviewView[];
  byId(
    serviceId: string,
  ): { readonly box: BoxRef; readonly ownerId: string; readonly view: ServiceView } | null;
  /** The service's output, each line redacted by the daemon before it is returned. */
  logs(box: BoxRef, name: string): Promise<string[]>;
  onChange(listener: (event: PreviewsEvent, ownerId: string) => void): () => void;
  /** Stops listening to the runtime; the records stay. */
  close(): void;
}

export interface PreviewRegistryDeps {
  readonly runtime: RegistryRuntime;
  /** The guest ops of the project boxes and of the agents' VMs. */
  readonly ops: { readonly project: BoxOps; readonly agent: BoxOps };
  readonly tokens: Pick<PreviewTokens, "revokeService" | "revokeBox">;
  /** The owner's secrets masked in one line (UX2-R30): the guest holds no vault, so the daemon does it. */
  readonly redact: (line: string) => Promise<string>;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
}

interface Rec {
  readonly ownerId: string;
  view: ServiceView;
}

interface BoxState {
  readonly box: BoxRef;
  readonly recs: Map<string, Rec>;
  /** Names whose start or restart the guest is answering (a starting service is not in its list but counts toward the cap). */
  readonly inflight: Map<string, number>;
  /** The box stopped while a call was out: whatever it answers is no longer the registry's. */
  dropped: boolean;
}

const ALL_LIMIT = 256;
const live = (rec: Rec): boolean => rec.view.state === "running";

/**
 * The daemon's mirror of the guest's preview services, per box (UX-2 §5, UX2-R29). Start, stop and restart are guest
 * operations of the owner or the agent (they count as activity); the list and the logs are polls that never keep a box awake.
 * An exit report marks a record; a stop, a restart or the end of the box revokes the tokens of the service it ends.
 */
export function createPreviewRegistry(deps: PreviewRegistryDeps): PreviewRegistry {
  const { runtime, tokens, logger } = deps;
  const boxes = new Map<string, BoxState>();
  const links = new Map<string, { link: RegistryLink; off: () => void }>();
  const listeners = new Set<(event: PreviewsEvent, ownerId: string) => void>();
  const opsOf = (box: BoxRef): BoxOps => (box.kind === "agent" ? deps.ops.agent : deps.ops.project);

  const emit = (event: PreviewsEvent, ownerId: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event, ownerId);
      } catch (error) {
        logger.warn("preview_listener_failed", { err: error });
      }
    }
  };
  const viewOf = (state: BoxState, rec: Rec): PreviewView => ({ ...rec.view, box: state.box });
  const publish = (state: BoxState, rec: Rec): void =>
    emit({ type: "service", service: viewOf(state, rec) }, rec.ownerId);
  const remove = (state: BoxState, name: string): void => {
    const rec = state.recs.get(name);
    if (rec === undefined) return;
    state.recs.delete(name);
    tokens.revokeService(rec.view.id);
    emit({ type: "removed", box: state.box, name }, rec.ownerId);
  };
  /** The record takes the guest's view; tokens die with a service that is no longer running. */
  const update = (state: BoxState, rec: Rec, view: ServiceView): void => {
    if (JSON.stringify(rec.view) === JSON.stringify(view)) return;
    if (rec.view.id !== view.id || view.state !== "running") tokens.revokeService(rec.view.id);
    rec.view = view;
    publish(state, rec);
  };

  function dropBox(box: BoxRef): void {
    const key = boxKey(box);
    const attached = links.get(key);
    if (attached !== undefined) {
      attached.off();
      links.delete(key);
    }
    tokens.revokeBox(box);
    const state = boxes.get(key);
    if (state === undefined) return;
    state.dropped = true;
    boxes.delete(key);
    for (const [name, rec] of state.recs) emit({ type: "removed", box, name }, rec.ownerId);
    state.recs.clear();
  }

  function onReport(state: BoxState, report: Extract<GuestReport, { type: "service" }>): void {
    const rec = [...state.recs.values()].find((candidate) => candidate.view.id === report.id);
    if (rec === undefined || !live(rec)) return;
    update(state, rec, { ...rec.view, state: "exited" });
  }

  /** Listens to the box's link once: its service reports, and its end. */
  function attach(box: BoxRef): void {
    const link = runtime.link(box);
    const key = boxKey(box);
    if (link === undefined || links.get(key)?.link === link) return;
    links.get(key)?.off();
    const off = link.onServiceReport((report) => {
      // A throw here would close the whole guest link: nothing leaves this listener.
      try {
        const state = boxes.get(key);
        if (state !== undefined) onReport(state, report);
      } catch (error) {
        logger.warn("preview_report_failed", { box: key, err: error });
      }
    });
    links.set(key, { link, off });
    void link.closed.then(() => {
      // The next VM of the box has its own link: only the one that ended drops the box.
      if (links.get(key)?.link === link) dropBox(box);
    });
  }

  const stopListening = runtime.onPhase((box, phase) => {
    if (phase === "running") attach(box);
    else if (phase === "stopped") dropBox(box);
  });

  const stateOf = (box: BoxRef): BoxState => {
    const key = boxKey(box);
    let state = boxes.get(key);
    if (state === undefined) {
      state = { box, recs: new Map(), inflight: new Map(), dropped: false };
      boxes.set(key, state);
    }
    return state;
  };
  const missing = (box: BoxRef): PapError =>
    new PapError(runtime.phase(box) === "running" ? "not_found" : "box_stopped");
  const liveNames = (state: BoxState): Set<string> => {
    const names = new Set(state.inflight.keys());
    for (const [name, rec] of state.recs) if (live(rec)) names.add(name);
    return names;
  };
  /**
   * The daemon's request is the record, not the guest's word (a compromised guest answers what it likes): the answer must carry
   * the requested name and port, its id must not be one already recorded for another service, and `network` is what the daemon
   * asked for, never what the guest says. A refusal is logged without any guest text.
   */
  function trusted(
    state: BoxState,
    view: ServiceView,
    expected: { name: string; port: number; network: boolean },
  ): ServiceView {
    let why: string | null = null;
    if (view.name !== expected.name || view.port !== expected.port) why = "other_service";
    else
      for (const other of boxes.values())
        for (const rec of other.recs.values())
          if (rec.view.id === view.id && !(other === state && rec.view.name === expected.name))
            why = "id_in_use";
    if (why !== null) {
      logger.warn("preview_guest_answer_refused", { box: boxKey(state.box), why });
      throw new PapError("internal");
    }
    return { ...view, network: expected.network };
  }

  /** The guest's `conflict` on a start is its cap: a hidden starting service counts toward it. */
  const capped = (error: unknown): unknown =>
    error instanceof PapError && error.code === "conflict" ? new PapError("limit_reached") : error;

  /** The guest evicts its oldest dead record at a fifth name: the registry does the same. */
  function makeRoom(state: BoxState, name: string): void {
    if (state.recs.has(name) || state.recs.size < SERVICE_LIMITS.perBox) return;
    let oldest: string | null = null;
    for (const [other, rec] of state.recs)
      if (
        !live(rec) &&
        (oldest === null || rec.view.startedAt < (state.recs.get(oldest)?.view.startedAt ?? 0))
      )
        oldest = other;
    if (oldest !== null) remove(state, oldest);
  }

  async function run(
    box: BoxRef,
    ownerId: string,
    name: string,
    expected: { port: number; network: boolean },
    ask: (ops: BoxOps) => Promise<ServiceView>,
  ): Promise<ServiceView> {
    const state = stateOf(box);
    const names = liveNames(state);
    if (!names.has(name) && names.size >= SERVICE_LIMITS.perBox) throw new PapError("limit_reached");
    state.inflight.set(name, (state.inflight.get(name) ?? 0) + 1);
    let view: ServiceView;
    try {
      view = await ask(opsOf(box)).catch((error: unknown) => {
        throw capped(error);
      });
    } catch (error) {
      // A call that failed on a box with nothing recorded leaves no state behind.
      if (state.recs.size === 0 && state.inflight.size === 1 && boxes.get(boxKey(box)) === state)
        boxes.delete(boxKey(box));
      throw error;
    } finally {
      const left = (state.inflight.get(name) ?? 1) - 1;
      if (left > 0) state.inflight.set(name, left);
      else state.inflight.delete(name);
    }
    if (state.dropped) throw new PapError("box_stopped");
    view = trusted(state, view, { name, ...expected });
    const known = state.recs.get(name);
    if (known !== undefined) update(state, known, view);
    else {
      makeRoom(state, name);
      const rec: Rec = { ownerId, view };
      state.recs.set(view.name, rec);
      publish(state, rec);
    }
    return view;
  }

  const self: PreviewRegistry = {
    start(box, ownerId, spec, signal) {
      attach(box);
      return run(box, ownerId, spec.name, { port: spec.port, network: spec.network }, (ops) =>
        ops.call(
          box.id,
          {
            name: "svc.start",
            service: spec.name,
            command: spec.command,
            port: spec.port,
            network: spec.network,
          },
          signal,
        ),
      );
    },
    async stop(box, name) {
      const state = boxes.get(boxKey(box));
      const rec = state?.recs.get(name);
      if (state === undefined || rec === undefined) return false;
      const { stopped } = await opsOf(box).call(box.id, { name: "svc.stop", service: name });
      if (state.dropped) return stopped;
      if (stopped) update(state, rec, { ...rec.view, state: "stopped" });
      else if (live(rec))
        await self.refresh(box).catch((error: unknown) => {
          logger.warn("preview_refresh_failed", { box: boxKey(box), err: error });
        });
      return stopped;
    },
    async restart(box, name) {
      const rec = boxes.get(boxKey(box))?.recs.get(name);
      if (rec === undefined) throw missing(box);
      try {
        const { port, network } = rec.view;
        return await run(box, rec.ownerId, name, { port, network }, (ops) =>
          ops.call(box.id, { name: "svc.restart", service: name }),
        );
      } catch (error) {
        // The guest evicted the record to make room for another name: it is gone there, so it is gone here.
        const state = boxes.get(boxKey(box));
        if (error instanceof PapError && error.code === "not_found" && state !== undefined)
          remove(state, name);
        throw error;
      }
    },
    list: (box) => [...(boxes.get(boxKey(box))?.recs.values() ?? [])].map((rec) => rec.view),
    async refresh(box) {
      const { services } = await opsOf(box).poll(box.id, { name: "svc.list" });
      const state = boxes.get(boxKey(box));
      if (state === undefined || state.dropped) return [];
      const seen = new Set<string>();
      for (const view of services) {
        seen.add(view.name);
        const rec = state.recs.get(view.name);
        if (rec === undefined) continue;
        try {
          update(state, rec, trusted(state, view, rec.view));
        } catch {
          // Refused and logged by `trusted`: the record keeps what the daemon knows.
        }
      }
      for (const name of [...state.recs.keys()])
        if (!seen.has(name) && !state.inflight.has(name)) remove(state, name);
      return self.list(box);
    },
    all(ownerId) {
      const out: PreviewView[] = [];
      for (const state of boxes.values())
        for (const rec of state.recs.values())
          if (rec.ownerId === ownerId && out.length < ALL_LIMIT) out.push(viewOf(state, rec));
      return out;
    },
    byId(serviceId) {
      for (const state of boxes.values())
        for (const rec of state.recs.values())
          if (rec.view.id === serviceId) return { box: state.box, ownerId: rec.ownerId, view: rec.view };
      return null;
    },
    async logs(box, name) {
      if (boxes.get(boxKey(box))?.recs.has(name) !== true) throw missing(box);
      const { lines } = await opsOf(box).poll(box.id, { name: "svc.logs", service: name });
      try {
        return await Promise.all(lines.map((line) => deps.redact(line)));
      } catch (error) {
        // A redactor that fails gives no line: unmasked output never leaves.
        logger.warn("preview_redaction_failed", { err: error });
        throw new PapError("internal");
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: stopListening,
  };
  return self;
}

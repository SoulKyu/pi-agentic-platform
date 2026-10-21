import { type InitRecord, PapError, type SessionStreamEvent } from "@pap/contracts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { initTools, storeNewSession } from "./automation-port.ts";
import { storeChildPolicy } from "./child-port.ts";
import { type AgentLaunch, applyProfileModel, initFieldsOf, refusedModelNotice } from "./agent-gate.ts";
import type { AgentSurface } from "./agent-surface.ts";
import { createEgressLink } from "./egress-link.ts";
import type { createGrantLink } from "./grants.ts";
import { type LiveSession, startLiveSession } from "./live-session.ts";
import type { PolicyLink } from "./policy-link.ts";
import { bridgePlatform } from "./platform-bridge.ts";
import { type MemoryRelease, memoryTrustOf } from "./memory-trust.ts";
import { createPreReadyBuffer } from "./pre-ready-buffer.ts";
import type { SessionsServiceDeps } from "./service.ts";
import { createStoreSync } from "./service-sync.ts";
import { type SessionRow, type StoredPreset, storedPresetOf } from "./store.ts";
import { vmTargets } from "./vm-attachments.ts";
import { vmBranchOf, type VmStarted } from "./vm-launch.ts";

/** What starting a worker needs of the service: its deps and the maps it shares with it (M4R27). */
export interface LaunchContext {
  readonly deps: SessionsServiceDeps;
  readonly live: Map<string, LiveSession>;
  readonly reopening: Map<string, Promise<LiveSession>>;
  readonly starting: Set<LiveSession>;
  readonly grants: ReturnType<typeof createGrantLink>;
  /** What ties the sessions to the policy module: the rules of each worker, its audit hand-over, a refused update. */
  readonly policyLink: PolicyLink;
  /** Who a session is, which platform tools its worker starts with, and where its platform calls go (M11). */
  readonly agent: AgentSurface;
  /** Which workers started untainted: a taint releases them once their run settles (M11R143). */
  readonly memory: MemoryRelease;
  /** `vm`: a VM worker, whose memory the VM cap counts: the free-memory floor does not apply (R29). */
  checkCapacity(vm?: boolean): void;
  /** Sessions whose VM worker is being spawned: they count against `PAP_MAX_WORKERS` (R29). */
  readonly booting: Set<string>;
  /** The service is shutting down: no worker starts. */
  closing(): boolean;
  /** The profile prompt of a child made by this daemon, for a start after the first (M11R136); none otherwise. */
  childPrompt?(row: SessionRow): string | undefined;
  /** The owner's last worker stays free (M10R154): `capacity` when one more worker would take it. */
  keepOneFree(): void;
  /** Sessions whose next launch must leave the last worker free: the agent port's and the runner's (consumed by `launch`). */
  readonly keepFreeFor: Set<string>;
  /** Sessions whose cold start must come up in the sandbox (owner a5): `sandbox_unavailable` otherwise. */
  readonly sandboxedOnly: ReadonlySet<string>;
  /** The session's tool preset now (null: configured): a new session's row is not stored yet, a stored one may have changed. */
  toolPreset(row: SessionRow): StoredPreset | null;
  /** The project for a new session's row, called once after `ready` and before the row is stored (M4R28). */
  projectFor?(row: SessionRow): string | null;
  /** After `ready`, for a row without a Pi file: the Pi id its worker reported (M4R123). */
  onDraftReady?(sessionId: string, piSessionId: string): void;
  /**
   * After an event reached the session's subscribers. Skipped for what a new session said before its row was stored
   * (replayed from the buffer without it) and for the `status` events of `live-session` while `stored` is false.
   */
  onPublished?(sessionId: string, event: SessionStreamEvent): void;
  /** After a reopen settled, success or failure: `reopening` no longer holds the session, so its status has changed. */
  onReopened?(sessionId: string): void;
  /** In the worker's `onExit`, after `live` forgot the session (owner Q13). */
  onWorkerEnd?(sessionId: string): void;
  /** From the worker's spawn to the end of `launch`, success or failure: its file may be written before `live` holds it. */
  onStarting?(sessionId: string): void;
  onStarted?(sessionId: string): void;
  /** Before a cold session's worker is spawned; a throw refuses the start (MC19 c). */
  beforeStart?(row: SessionRow): void;
}

/** Starts a session's worker (`launch`) or hands out the one that runs (`ensureLive`). Moved out of `service.ts` as is. */
export function createLaunch(ctx: LaunchContext) {
  const { deps, live, reopening, starting, grants, policyLink } = ctx;
  const bridgeEgress = createEgressLink(deps.logger);
  const { bindPiFile, recordEvent, syncName, replayPreReady } = createStoreSync({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    hub: deps.hub,
    agentDir: deps.worker.agentDir,
    papHome: deps.worker.papHome,
    onPolicyRecord: (row, raw) => policyLink.audited(row, raw),
    onTaint: (row, epoch) => policyLink.tainted(row, epoch),
  });

  // `row` is stored when the worker is ready for a new session (a failed start leaves no trace), and already
  // stored when a cold session is reopened. What a new session's worker says before its row exists is held in a
  // small bounded buffer and replayed once the row is stored; a start that fails drops it with the rest.
  async function launch(row: SessionRow, isNew: boolean): Promise<LiveSession> {
    // The gate of every agent session, first of all (M11R53): for a host row the one await before the spawn, so no check
    // can fall between; a VM row awaits its VM too, and `start` reads again what the boot may have changed.
    const gating = ctx.agent.gate(row);
    const agentLaunch = gating ? await gating : null;
    // An agent thread runs with its profile's preset narrowed by the owner's choice, read at each start (M11R47, W5-R28).
    // The choice is read from the store, after the gate: the row was read before the waits of `ensureLive` and `prompt`.
    if (agentLaunch?.role === "thread" && !isNew) {
      const ownerPreset = deps.store.get(row.id)?.ownerPreset;
      deps.store.setToolPreset(
        row.id,
        storedPresetOf(ctx.agent.presetFor(ownerPreset, agentLaunch.input.preset)),
      );
    }
    // A child's stored preset is narrowed to its agent's at every reopen, never widened (review I3).
    if (agentLaunch?.role === "child" && !isNew)
      deps.store.setToolPreset(
        row.id,
        storedPresetOf(
          ctx.agent.presetFor(deps.store.toolPreset(row.id) ?? "configured", agentLaunch.input.preset),
        ),
      );
    try {
      // Owner a5, M11R214: an unattended continuation of a full-access agent never starts a worker without its sandbox
      // (R38: a VM worker is one).
      if (ctx.sandboxedOnly.has(row.id) && agentLaunch?.sandbox === undefined && agentLaunch?.vm !== true)
        throw new PapError("sandbox_unavailable");
      return await start(row, isNew, agentLaunch);
    } catch (error) {
      // Any throw before or after the spawn: the start-time profile of a worker that never came up is dropped (W5-R26).
      ctx.agent.ended(row.id);
      ctx.memory.ended(row.id);
      throw error;
    }
  }

  async function start(
    row: SessionRow,
    isNew: boolean,
    agentLaunch: AgentLaunch | null,
  ): Promise<LiveSession> {
    deps.laneHooks?.assertOwn(row.ownerId, row.cwd);
    // The one VM predicate (`vmLayoutOf(row) !== null`), checked against the gate's answer: a mismatch refuses the launch.
    const vmLaunch = vmBranchOf(ctx.agent.vmLayoutOf(row) !== null, agentLaunch, deps.vmLaunch);
    ctx.checkCapacity(vmLaunch !== null);
    if (ctx.keepFreeFor.delete(row.id)) ctx.keepOneFree();
    if (!isNew) ctx.beforeStart?.(row);
    let stored = !isNew;
    const preReady = isNew ? createPreReadyBuffer() : null;
    let bound = row.piPath !== null;
    // From here to the worker's exit every compose reads the profile this start used (W5-R26).
    if (agentLaunch)
      ctx.agent.started(row.id, {
        input: agentLaunch.input,
        name: agentLaunch.agent.name,
        quarantined: false,
      });
    // The scope, the rules and `init` are composed in one synchronous step; a VM start composes them again after its wait.
    const compose = () => {
      const scope = grants.scopeOf(row.cwd);
      const rules = policyLink.compose(row, scope);
      const childPrompt = ctx.childPrompt?.(row);
      // Read in the same step as the rules: the taint the worker starts with is the taint this decision is made on.
      const kind = ctx.agent.kindOfRow(row);
      const trust = memoryTrustOf(kind, agentLaunch);
      // A VM worker has no pi-mem0: no trusted memory decision is recorded for it (T8a).
      if (!vmLaunch) ctx.memory.started(row.id, trust);
      const init: InitRecord = {
        type: "init",
        cwd: row.cwd,
        agentDir: deps.worker.agentDir,
        papHome: deps.worker.papHome,
        umask: deps.worker.umask,
        papSessionId: row.id,
        policy: rules,
        tools: initTools(ctx.toolPreset(row), rules),
        platform: { ops: ctx.agent.platformOps(row) },
        ...(agentLaunch ? initFieldsOf(agentLaunch) : {}),
        ...(childPrompt ? { child: { prompt: childPrompt } } : {}),
        ...(trust.memory ? { memory: trust.memory } : {}),
        // Only a file this session has recorded is reopened. A draft has none: Pi starts a new session for it.
        ...(row.piPath ? { sessionFile: row.piPath } : {}),
        ...(deps.worker.testProviderScript ? { testProviderScript: deps.worker.testProviderScript } : {}),
      };
      return { scope, rules, trust, init };
    };
    let composed = compose();
    const logger = deps.logger.child({ component: "session", sessionId: row.id });
    // A reopened session has subscribers who last saw it cold; a new one has none yet (R112).
    if (!isNew) {
      const starting: SessionStreamEvent = { kind: "status", status: "starting" };
      deps.hub.publish("session", row.id, starting);
      ctx.onPublished?.(row.id, starting);
    }
    let handle: WorkerHandle;
    if (vmLaunch && agentLaunch) {
      // The VM may take a while to boot: it counts as a worker meanwhile (R29).
      ctx.booting.add(row.id);
      let started: VmStarted;
      try {
        started = await vmLaunch.spawn(row, agentLaunch, composed.init);
      } finally {
        ctx.booting.delete(row.id);
      }
      // The gate's facts and the capacity check are older than the boot: read again, and a refusal stops the worker.
      composed = started.bind(() => {
        const profile = ctx.agent.profileOf(row.ownerId, agentLaunch.agent.id);
        if (profile === null) throw new PapError("not_found");
        if (profile.quarantined) throw new PapError("agent_paused");
        if (ctx.closing()) throw new PapError("capacity");
        return compose();
      });
      handle = started.handle;
    } else {
      const env = { ...agentLaunch?.claudeEnv, ...composed.trust.env };
      handle = Object.keys(env).length > 0 ? deps.spawn(row.cwd, env) : deps.spawn(row.cwd);
    }
    const { scope, rules, init } = composed;
    const session: LiveSession = startLiveSession(
      {
        handle,
        clock: deps.clock,
        logger,
        publish: (event) => {
          if (stored) {
            deps.hub.publish("session", row.id, event);
            ctx.onPublished?.(row.id, event);
          }
          // A status is not held: the snapshot carries the status, and no one can have seen an earlier one.
          else if (event.kind !== "status") preReady?.add({ kind: "publish", event });
        },
        record: (kind, data) => {
          deps.runs?.onRecord(row, kind, data, session.loadout());
          if (stored) recordEvent(row.id, kind, data);
          else preReady?.add({ kind: "record", recordKind: kind, data });
        },
        idleMs: deps.idleMs,
        held: () => deps.laneHooks?.waiting(row.id) ?? false,
        // Before the row exists the name is taken from the session once it is ready (below).
        onName: (name) => {
          if (stored) syncName(row.id, name);
        },
        onActivity: () => {
          if (stored && !bound) bound = bindPiFile(row, session);
        },
        onExit: () => {
          if (live.get(row.id) === session) {
            live.delete(row.id);
            ctx.agent.ended(row.id);
            ctx.memory.ended(row.id);
          }
          ctx.onWorkerEnd?.(row.id);
        },
        onWorkerExit: (info) => deps.onWorkerExit?.(row.id, info),
        onPolicyRefused: () => policyLink.refused(row, session),
        onCardShown: (toolCallId, answers, at) => policyLink.cardShown(row, toolCallId, answers, at),
        observe: (event) => deps.runs?.onEvent(row.id, event),
      },
      init,
    );
    if (init.vm) vmTargets.set(session, { handle, inbox: init.vm.layout.inbox, clock: deps.clock, logger });
    bridgePlatform(handle, row, ctx.agent, logger);
    // The scope is the start-time snapshot of the rules this worker got (W5-R26); an owner session has none and is refused.
    bridgeEgress(
      handle,
      agentLaunch ? ctx.agent.egressScope(row, rules, agentLaunch.sandbox) : null,
      ctx.agent.egress,
    );
    // Nothing awaits between the rules in `init` and here, so a change cannot fall between the two.
    grants.track(session, row, scope);
    starting.add(session);
    ctx.onStarting?.(row.id);
    try {
      await session.ready;
      // The file of a recorded session says who it is. Another id means the file was replaced under us.
      if (row.piSessionId !== null && session.piSessionId() !== row.piSessionId)
        throw new PapError("worker_failed");
      if (isNew)
        deps.store.transaction(() => {
          storeNewSession(deps, row, ctx.projectFor?.(row) ?? null);
          storeChildPolicy(deps, row);
        });
      stored = true;
      // Pi writes the file with the first message: until then the row keeps the Pi id its worker reported (M4R123).
      const piId = session.piSessionId();
      if (row.piPath === null && piId) ctx.onDraftReady?.(row.id, piId);
      // `ready` said Pi's name before the row could hold it (a new session) or this worker's start may have changed it.
      syncName(row.id, session.name());
      if (preReady) replayPreReady(row.id, preReady.drain());
      // Whoever watches the session while it was cold saw the cached name (R112).
      if (session.name() !== row.name) {
        const named: SessionStreamEvent = { kind: "name", name: session.name() };
        deps.hub.publish("session", row.id, named);
        ctx.onPublished?.(row.id, named);
      }
      live.set(row.id, session);
      // A secret saved or deleted while the worker booted found no live session: bring the worker level now (M11R86).
      const drift = agentLaunch ? ctx.agent.vaultDrift(row, agentLaunch) : null;
      if (drift && !session.send(drift)) throw new PapError("worker_failed");
      bound = bound || bindPiFile(row, session);
      if (agentLaunch)
        await applyProfileModel(session, agentLaunch, (what, how) => {
          logger.warn("agent_profile_not_applied", { what, how });
          // The owner sees it in the session too: the run goes on, on the model the worker has.
          const saved = agentLaunch.input.model;
          const loadout = session.loadout();
          if (what === "model" && saved)
            session.notice(
              refusedModelNotice({
                saved,
                running: loadout?.model ?? null,
                how,
                chatOnly: loadout?.preset === "chat",
              }),
            );
        });
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    } finally {
      starting.delete(session);
      ctx.onStarted?.(row.id);
    }
  }

  // A session being released has a worker that drops what it is sent: it is waited for, and the next worker opens the
  // same Pi file. `onExit` has forgotten the session by the time `exited()` resolves, so the second look finds none.
  async function ensureLive(row: SessionRow): Promise<LiveSession> {
    const closing = live.get(row.id);
    // No deadline of its own: the worker's kill ladder ends it within seconds (spec C 2.5).
    if (closing?.stopping()) await closing.exited();
    // One whose exit could not be handled is still listed, and is not a worker to give a prompt to.
    const current = live.get(row.id);
    if (current && !current.stopping()) return current;
    const pending = reopening.get(row.id);
    if (pending) return pending;
    const reopened = launch(row, false);
    reopening.set(row.id, reopened);
    try {
      return await reopened;
    } finally {
      reopening.delete(row.id);
      // The status published during the reopen was read while `reopening` still held the session.
      ctx.onReopened?.(row.id);
    }
  }

  return { launch, ensureLive };
}

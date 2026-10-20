import { type Caller, PapError, type SessionStatus } from "@pap/contracts";
import { resolveSessionCwd } from "./cwd.ts";
import { createForks } from "./forks.ts";
import { createAttention, createAutomationPort } from "./automation-port.ts";
import { createAgentPort } from "./agent-port.ts";
import { createChildPort } from "./child-port.ts";
import { createSidebarHub } from "./sidebar-hub.ts";
import { createWorkerRoom } from "./worker-room.ts";
import { createAgentSurface } from "./agent-surface.ts";
import { createPolicyLink } from "./policy-link.ts";
import { createProjectLink } from "./project-link.ts";
import type { LiveSession } from "./live-session.ts";
import { createOrganiser } from "./organiser.ts";
import { createPromptFlow } from "./service-prompt.ts";
import { createFolderRestart } from "./restart-folder.ts";
import { createAdoption } from "./service-adopt.ts";
import { createSessionCommands } from "./service-commands.ts";
import { createSessionModels } from "./service-models.ts";
import { createLaunch } from "./service-launch.ts";
import { createSessionMarks } from "./service-marks.ts";
import { createMemoryRelease } from "./memory-trust.ts";
import { createSessionReads } from "./service-reads.ts";
import { createShellView } from "./service-shell.ts";
import { createShellPublisher } from "./shell-publisher.ts";
import { fitSummaries } from "./shell.ts";
import { type SessionRow, storedPresetOf } from "./store.ts";
import type { SessionsService, SessionsServiceDeps, SessionsServiceWithAutomation } from "./service-types.ts";

// What changes a sidebar summary: the status, an open dialog or approval, the name (M4R34).
const SUMMARY_EVENTS: ReadonlySet<string> = new Set(["status", "dialog_open", "dialog_closed", "name"]);

export type { SessionsService, SessionsServiceDeps };

export function createSessionsService(deps: SessionsServiceDeps): SessionsServiceWithAutomation {
  // Workers that are up, by session id. A crashed worker leaves this map and is not replaced until the next prompt.
  const live = new Map<string, LiveSession>();
  // A cold session being brought up, so that concurrent commands start one worker, not several.
  const reopening = new Map<string, Promise<LiveSession>>();
  // Workers between fork and `ready`. They count against the cap like running ones (R9).
  const starting = new Set<LiveSession>();
  let closing = false;
  const presetOf = (row: SessionRow) => {
    const stored = deps.store.get(row.id);
    return stored ? (stored.toolPreset ?? null) : (row.toolPreset ?? null);
  };
  const agent = createAgentSurface(deps);
  const policyLink = createPolicyLink({
    ...deps,
    sessions: () => [...live.values(), ...starting],
    toolPreset: presetOf,
    agentRules: agent.rulesOf,
    agentModeOf: agent.modeOf,
  });
  const grants = policyLink.grants;

  const room = createWorkerRoom({
    live,
    starting,
    limits: deps.limits,
    freeMemMb: () => deps.freeMemMb(),
    closing: () => closing,
  });

  const marks = deps.store.marks;
  const link = createProjectLink({
    store: marks,
    projects: deps.projects,
    scopeOf: deps.policy.scopeOf,
    logger: deps.logger,
  });

  const statusOf = (id: string): SessionStatus =>
    live.get(id)?.status() ?? (reopening.has(id) ? "starting" : "cold");

  const shell = createShellView({
    store: marks,
    projects: deps.projects,
    live: (id) => ({
      status: statusOf(id),
      needsInput: (live.get(id)?.dialogs().length ?? 0) > 0 || child.waiting(id),
    }),
  });
  const attention = createAttention(deps.logger);
  const sidebarHub = createSidebarHub(deps.store, deps.hub);
  const publisher = createShellPublisher({
    hub: attention.wrap(sidebarHub),
    summary: shell.summary,
    project: shell.project,
    archivedCount: marks.countArchived,
    logger: deps.logger,
    clock: deps.clock,
  });
  deps.projects.onChange((ownerId, view) => publisher.projectChanged(ownerId, view.id));
  const organiser = createOrganiser({
    store: marks,
    clock: deps.clock,
    logger: deps.logger,
    publisher,
    isLive: (id) => live.has(id),
    readOnly: deps.store.readOnly,
  });

  const adoption = createAdoption({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    ownerId: deps.ownerId,
    ...(deps.onAdopted ? { onAdopted: deps.onAdopted } : {}),
    onOutsideToolResults: deps.onOutsideToolResults,
    live,
    link,
    publisher,
    activity: organiser.activity,
    summary: shell.summaryFor,
  });

  const promptWaiting = (id: string): boolean => deps.laneHooks?.waiting(id) ?? false;
  const folderRestart = createFolderRestart({
    live,
    reopening,
    row: (id) => deps.store.get(id),
    logger: deps.logger,
    waiting: promptWaiting,
  });
  const memory = createMemoryRelease({
    policy: deps.policy,
    release: folderRestart.releaseIdle,
    logger: deps.logger,
  });
  const { launch, ensureLive } = createLaunch({
    deps,
    memory,
    live,
    reopening,
    starting,
    grants,
    policyLink,
    agent,
    ...room,
    toolPreset: presetOf,
    // An agent's sessions belong to the agent, not to a project (M11R56).
    childPrompt: (row) => child.promptOf(row),
    projectFor: (row) => (row.agentId === undefined ? link.projectOf(row.ownerId, row.cwd) : null),
    onReopened: (sessionId) => {
      publisher.changed(sessionId);
      folderRestart.reopened(sessionId);
      memory.reopened(sessionId);
    },
    onPublished: (sessionId, event) => {
      folderRestart.published(sessionId, event);
      memory.published(sessionId, event);
      deps.laneHooks?.published(sessionId, event);
      child.published(sessionId, event);
      // A run starting is activity: the session leaves Settled and Snoozed (M4R41).
      if (event.kind === "status" && event.status === "running") organiser.activity(sessionId);
      if (SUMMARY_EVENTS.has(event.kind)) publisher.changed(sessionId);
    },
    ...adoption.launchHooks,
  });
  const owned = (sessionId: string, caller: Caller): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== caller.userId) throw new PapError("not_found");
    return row;
  };

  const sendPrompt = createPromptFlow({ deps, memory, ensureLive, organiser, publisher, owned });

  // A fork would be a second thread, or a plain session in the agent's home (M11R179).
  const notAgent = (row: SessionRow): SessionRow => {
    if (row.agentId !== undefined) throw new PapError("bad_request");
    return row;
  };

  // The worker a dialog or a panel answer may go to: none once it is being released, whose dialogs closed with it.
  const openWorker = (id: string): LiveSession => {
    const session = live.get(id);
    if (!session || session.stopping()) throw new PapError("not_found");
    return session;
  };

  const reads = createSessionReads({
    store: deps.store,
    agentDir: deps.worker.agentDir,
    loadTranscript: deps.loadTranscript,
    live,
    statusOf,
    owned,
    outsideWrite: adoption.outsideWrite,
    policyView: (row) => policyLink.viewOf(row),
    children: (id) => child.viewsOf(id),
  });

  const commands = createSessionCommands({
    owned,
    ensureLive,
    live,
    waiting: promptWaiting,
    reads,
    hub: deps.hub,
    exports: deps.exports,
    logger: deps.logger,
  });
  const modelCommands = createSessionModels({
    owned,
    ensureLive,
    waiting: promptWaiting,
    logger: deps.logger,
    store: deps.store,
    running: async (id) => live.get(id) ?? (await reopening.get(id)?.catch(() => null)) ?? null,
    // The worker is sent the whole rules, which now say whether the preset is read-only.
    presetChanged: (row) => grants.pushWhere((tracked) => tracked.id === row.id),
    clampPreset: agent.clampPreset,
  });
  const forks = createForks({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    loadWriter: deps.loadWriter,
    ...(deps.admission ? { admit: deps.admission.fork } : {}),
    onMade: adoption.fileMade,
    // A fork or clone never starts looser than its source: mode and taint (owner Q15), and the tool preset (Task 15).
    onAdopted: (source, id) => {
      policyLink.inherit(source, id);
      deps.store.setToolPreset(id, presetOf(source));
    },
  });
  const sessionMarks = createSessionMarks({
    store: marks,
    clock: deps.clock,
    owned,
    publisher,
    onSnoozeChange: organiser.rearm,
    // The running worker holds the grants in its rules: it is pushed the rules without them (W5-R35).
    onArchived: (sessionId) => {
      agent.hostGrants.drop(sessionId);
      grants.pushWhere((tracked) => tracked.id === sessionId);
      child.archived(sessionId);
    },
  });

  const filed = <T extends { sessionId: string }>(source: SessionRow, result: T): T => {
    const projectId = link.copy(source.id, result.sessionId);
    publisher.changed(result.sessionId);
    publisher.projectChanged(source.ownerId, projectId);
    return result;
  };

  const automation = createAutomationPort(
    {
      deps,
      live,
      starting,
      reopening,
      launch,
      attention,
      publisher,
      marks,
      room,
      sandboxed: agent.sandboxed,
      removed: (row) => child.removed(row),
    },
    () => self,
  );
  const agentSessions = createAgentPort({
    deps,
    live,
    starting,
    reopening,
    agent,
    marks,
    launch,
    ...room,
    releaseIdle: folderRestart.releaseIdle,
    models: () => self,
    lastText: reads.agentText,
  });
  const child = createChildPort({
    deps,
    live,
    agent,
    launch,
    ...room,
    modeOf: (row) => policyLink.viewOf(row).mode,
    lastText: reads.agentText,
    publisher,
    marks,
  });
  const self: SessionsServiceWithAutomation = {
    automation,
    agent,
    agentSessions,
    child,
    modeOf: (ownerId, sessionId) => policyLink.viewOf(owned(sessionId, { userId: ownerId } as Caller)).mode,
    async create(cwdInput, caller, preset) {
      const cwd = resolveSessionCwd(cwdInput, deps.worker.papHome);
      const now = deps.clock.now();
      const toolPreset = preset === undefined ? null : storedPresetOf(preset);
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd,
        ownerId: caller.userId,
        name: null,
        createdAt: now,
        updatedAt: now,
        ...(toolPreset ? { toolPreset } : {}),
      };
      await launch(row, true);
      publisher.changed(row.id);
      publisher.projectChanged(caller.userId, marks.row(row.id)?.projectId ?? null);
      return { sessionId: row.id };
    },
    listFitted: (caller) => fitSummaries(reads.summaries(caller)),
    list: (caller) => reads.summaries(caller),
    shellSnapshot: (ownerId) => shell.snapshot(ownerId),
    listArchived: shell.listArchived,
    summary: shell.summaryFor,
    async prompt(input, caller) {
      return sendPrompt(input, caller);
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      // A closing worker answers ok without being asked (M2R112): the live session sees to it.
      await live.get(sessionId)?.abort();
    },
    async reopen(sessionId, caller) {
      await ensureLive(owned(sessionId, caller));
    },
    navigate: (input, caller) => commands.navigate(input, caller),
    compact: (input, caller) => commands.compact(input, caller),
    rename: (input, caller) => commands.rename(input, caller),
    autoName: (sessionId, caller) => commands.autoName(sessionId, caller),
    exportHtml: (sessionId, caller) => commands.exportHtml(sessionId, caller),
    models: (sessionId, caller) => modelCommands.models(sessionId, caller),
    commands: (sessionId, caller) => modelCommands.commands(sessionId, caller),
    setModel: (input, caller) => modelCommands.setModel(input, caller),
    setThinking: (input, caller) => modelCommands.setThinking(input, caller),
    setTools: (input, caller) => modelCommands.setTools(input, caller),
    fork: async ({ sessionId, entryId }, caller) => {
      const row = notAgent(owned(sessionId, caller));
      return filed(row, await forks.fork(row, entryId));
    },
    clone: async ({ sessionId }, caller) => {
      const row = notAgent(owned(sessionId, caller));
      return filed(row, await forks.clone(row, live.get(row.id)?.leafId() ?? null));
    },
    async clearQueue(sessionId, caller) {
      owned(sessionId, caller);
      // A closing worker has an empty queue and drops requests: the live session answers without asking it (M2-RT-39).
      return (await live.get(sessionId)?.clearQueue()) ?? { steering: [], followUp: [], truncated: false };
    },
    respondDialog(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = openWorker(input.sessionId);
      agent.guardAnswer(session, input.dialogId, caller, input.response, row.id);
      const approved = session.answer(input.dialogId, input.response);
      agent.noted(row.id, approved, caller);
      if (approved?.answer === "host") grants.pushWhere((tracked) => tracked.id === row.id);
      grants.answered(session, approved);
      if (approved?.grant.toolCallId !== undefined)
        policyLink.answeredBy(row, approved.grant.toolCallId, caller, approved.answer);
    },
    panelInput(input, caller) {
      owned(input.sessionId, caller);
      openWorker(input.sessionId).panelInput(input.panelId, input.data);
    },
    history: (input, caller) => reads.history(input, caller),
    toolOutput: (input, caller) => reads.toolOutput(input, caller),
    branches: (sessionId, caller) => reads.branches(sessionId, caller),
    prepareSubscription: (sessionId, caller, after) => reads.prepare(sessionId, caller, after),
    snapshot: (sessionId) => reads.snapshot(sessionId),
    async shutdownAll() {
      closing = true;
      organiser.stop();
      policyLink.stop();
      memory.stop();
      await Promise.allSettled([...live.values(), ...starting].map((session) => session.stop()));
      // The workers are gone: the proxy removes its folders under the runtime folder (a tmpfs nobody else empties).
      await agent.egress()?.shutdown();
    },
    restartFolder: folderRestart.restart,
    releaseIdle: folderRestart.releaseIdle,
    laneProbe: { live, statusOf, branchPath: reads.branchPath, agentText: reads.agentText },
    inspect(sessionId) {
      const session = live.get(sessionId);
      return session ? { pid: session.pid(), rssMb: session.rssMb() } : null;
    },
    mark: (input, caller) => sessionMarks.mark(input, caller),
    startOrganiser: organiser.start,
    activity: organiser.activity,
    backfillProjects: () => (deps.store.readOnly ? 0 : link.backfill()),
    scanPort: adoption.scanPort,
  };
  return self;
}

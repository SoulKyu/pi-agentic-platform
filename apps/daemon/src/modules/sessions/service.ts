import { type Caller, PapError, type SessionStatus } from "@pap/contracts";
import { type AutomationContext, createAttention, createAutomationPort } from "./automation-port.ts";
import { createSessionsProjectPort } from "./project-port.ts";
import { createSessionsOwnerCascade } from "./owner-cascade.ts";
import { createAgentPort } from "./agent-port.ts";
import { createChildPort } from "./child-port.ts";
import { createSidebarHub } from "./sidebar-hub.ts";
import { createWorkerRoom } from "./worker-room.ts";
import { createAgentSurface } from "./agent-surface.ts";
import { createPolicyLink } from "./policy-link.ts";
import { createProjectLink } from "./project-link.ts";
import type { LiveSession } from "./live-session.ts";
import { createOrganiser } from "./organiser.ts";
import { createSessionCreate } from "./service-create.ts";
import { createPromptFlow } from "./service-prompt.ts";
import { createFolderRestart } from "./restart-folder.ts";
import { createAdoption } from "./service-adopt.ts";
import { createSessionCommands } from "./service-commands.ts";
import { createSessionModels } from "./service-models.ts";
import { createLaunch } from "./service-launch.ts";
import { createSessionMarks } from "./service-marks.ts";
import { createSessionReads } from "./service-reads.ts";
import { createShellView } from "./service-shell.ts";
import { createShellPublisher } from "./shell-publisher.ts";
import { openWorkerOf } from "./service-helpers.ts";
import { fitSummaries } from "./shell.ts";
import type { SessionRow } from "./store.ts";
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
    isMember: deps.isMember,
    boxes: deps.boxes,
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
  // A deleted box project and its sessions leave every client of the owner at once (a pending update of it reads no row and is skipped).
  deps.projects.onRemoved((ownerId, projectId) =>
    deps.hub.publish("shell", ownerId, { kind: "projectRemoved", projectId }),
  );
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
    papHome: deps.worker.papHome,
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
  const { launch, ensureLive } = createLaunch({
    deps,
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
    },
    onPublished: (sessionId, event) => {
      folderRestart.published(sessionId, event);
      deps.laneHooks?.published(sessionId, event);
      child.published(sessionId, event);
      // A run starting is activity: the session leaves Settled and Snoozed (M4R41).
      if (event.kind === "status" && event.status === "running") organiser.activity(sessionId);
      if (SUMMARY_EVENTS.has(event.kind)) publisher.changed(sessionId);
    },
    ...adoption.launchHooks,
    onStarted: (id) => (adoption.launchHooks.onStarted?.(id), deps.onSessionStarted?.(id)),
  });
  const owned = (sessionId: string, caller: Caller): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== caller.userId) throw new PapError("not_found");
    return row;
  };

  const sendPrompt = createPromptFlow({ deps, ensureLive, organiser, publisher, owned });
  const creating = createSessionCreate({
    deps,
    live,
    agent,
    policyLink,
    adoption,
    link,
    publisher,
    marks,
    launch,
    owned,
    presetOf,
  });

  const openWorker = openWorkerOf(live);

  const reads = createSessionReads({
    store: deps.store,
    agentDir: deps.worker.agentDir,
    papHome: deps.worker.papHome,
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
    runsInVm: (row) => agent.vmLayoutOf(row) !== null,
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
    providers: deps.providers,
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

  const automationCtx: AutomationContext = {
    deps,
    live,
    starting,
    reopening,
    launch,
    attention,
    publisher,
    marks,
    room,
    sandboxed: agent.shellSandboxed,
    removed: (row) => child.removed(row),
  };
  const automation = createAutomationPort(automationCtx, () => self);
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
    projectCleanup: createSessionsProjectPort(automationCtx),
    ownerCascade: createSessionsOwnerCascade(automationCtx),
    agent,
    agentSessions,
    child,
    ...creating,
    modeOf: (ownerId, sessionId) => policyLink.viewOf(owned(sessionId, { userId: ownerId } as Caller)).mode,
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
    availableModels: (caller) => modelCommands.availableModels(caller),
    commands: (sessionId, caller) => modelCommands.commands(sessionId, caller),
    setModel: (input, caller) => modelCommands.setModel(input, caller),
    setThinking: (input, caller) => modelCommands.setThinking(input, caller),
    setTools: (input, caller) => modelCommands.setTools(input, caller),
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
      await Promise.allSettled([...live.values(), ...starting].map((session) => session.stop()));
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

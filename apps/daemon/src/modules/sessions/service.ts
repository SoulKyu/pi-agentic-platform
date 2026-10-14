import { type Caller, PapError, type SessionStatus } from "@pap/contracts";
import { resolveSessionCwd } from "./cwd.ts";
import { createForks } from "./forks.ts";
import { createPolicyLink } from "./policy-link.ts";
import { createProjectLink } from "./project-link.ts";
import type { LiveSession } from "./live-session.ts";
import { createOrganiser } from "./organiser.ts";
import { createPromptAttachments, plainPrompt } from "./prompt-attachments.ts";
import { createFolderRestart } from "./restart-folder.ts";
import { createAdoption } from "./service-adopt.ts";
import { createSessionCommands } from "./service-commands.ts";
import { createSessionModels } from "./service-models.ts";
import { createLaunch } from "./service-launch.ts";
import { createSessionMarks } from "./service-marks.ts";
import { createSessionReads } from "./service-reads.ts";
import { createShellView } from "./service-shell.ts";
import { createShellPublisher } from "./shell-publisher.ts";
import { fitSummaries } from "./shell.ts";
import { type SessionRow, storedPresetOf } from "./store.ts";
import type { SessionsService, SessionsServiceDeps } from "./service-types.ts";

// What changes a sidebar summary: the status, an open dialog or approval, the name (M4R34).
const SUMMARY_EVENTS: ReadonlySet<string> = new Set(["status", "dialog_open", "dialog_closed", "name"]);

export type { SessionsService, SessionsServiceDeps };

const TOKEN_ANSWERS: ReadonlySet<string> = new Set(["deny", "once"]);

export function createSessionsService(deps: SessionsServiceDeps): SessionsService {
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
  const policyLink = createPolicyLink({
    ...deps,
    sessions: () => [...live.values(), ...starting],
    toolPreset: presetOf,
  });
  const grants = policyLink.grants;
  const attachments = createPromptAttachments(deps);

  const checkCapacity = () => {
    if (
      closing ||
      live.size + starting.size >= deps.limits.maxWorkers ||
      deps.freeMemMb() < deps.limits.minFreeMemMb
    ) {
      throw new PapError("capacity");
    }
  };

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
    live: (id) => ({ status: statusOf(id), needsInput: (live.get(id)?.dialogs().length ?? 0) > 0 }),
  });
  const publisher = createShellPublisher({
    hub: deps.hub,
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

  const folderRestart = createFolderRestart({
    live,
    reopening,
    row: (id) => deps.store.get(id),
    logger: deps.logger,
  });
  const { launch, ensureLive } = createLaunch({
    deps,
    live,
    reopening,
    starting,
    grants,
    policyLink,
    checkCapacity,
    toolPreset: presetOf,
    projectFor: (row) => link.projectOf(row.ownerId, row.cwd),
    onReopened: (sessionId) => {
      publisher.changed(sessionId);
      folderRestart.reopened(sessionId);
    },
    onPublished: (sessionId, event) => {
      folderRestart.published(sessionId, event);
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
  });

  const commands = createSessionCommands({
    owned,
    ensureLive,
    live,
    reads,
    hub: deps.hub,
    exports: deps.exports,
    logger: deps.logger,
  });
  const modelCommands = createSessionModels({
    owned,
    ensureLive,
    logger: deps.logger,
    store: deps.store,
    running: async (id) => live.get(id) ?? (await reopening.get(id)?.catch(() => null)) ?? null,
    // The worker is sent the whole rules, which now say whether the preset is read-only.
    presetChanged: (row) => grants.pushWhere((tracked) => tracked.id === row.id),
  });
  const forks = createForks({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    loadWriter: deps.loadWriter,
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
  });

  const filed = <T extends { sessionId: string }>(source: SessionRow, result: T): T => {
    const projectId = link.copy(source.id, result.sessionId);
    publisher.changed(result.sessionId);
    publisher.projectChanged(source.ownerId, projectId);
    return result;
  };

  return {
    async create(cwdInput, caller, preset) {
      const cwd = resolveSessionCwd(cwdInput);
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
      const row = owned(input.sessionId, caller);
      // Claimed for this session and owner before a worker is asked for anything; released only once Pi accepted (M8R43).
      const ids = input.attachments ?? [];
      const prepared =
        ids.length === 0
          ? plainPrompt(input.text)
          : await attachments.prepare(caller.userId, row.id, input.text, ids);
      const session = await ensureLive(row);
      deps.store.touch(row.id, deps.clock.now());
      organiser.activity(row.id);
      publisher.changed(row.id);
      const result = await session.prompt(prepared.text, input.streamingBehavior, prepared.images);
      prepared.accepted();
      return result;
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      // A closing worker answers ok without being asked (M2R112): the live session sees to it.
      await live.get(sessionId)?.abort();
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
      const row = owned(sessionId, caller);
      return filed(row, await forks.fork(row, entryId));
    },
    clone: async ({ sessionId }, caller) => {
      const row = owned(sessionId, caller);
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
      // A token answers deny or once (Q7): a rule that outlives the token is a browser session's to make.
      if (caller.kind === "token" && "answer" in input.response && !TOKEN_ANSWERS.has(input.response.answer))
        throw new PapError("forbidden");
      const approved = session.answer(input.dialogId, input.response);
      grants.answered(session, approved);
      if (approved?.grant.toolCallId !== undefined)
        policyLink.answeredBy(row, approved.grant.toolCallId, caller);
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
}

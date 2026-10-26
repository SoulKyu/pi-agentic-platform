import "./register-space-catalog.ts";
import { type AgentRequestView, type AgentSummary, type ToolPreset } from "@pap/contracts";
import { Button, LoadingLine, useIsPhone, useMediaQuery, usePendingAction, type AvatarStyle } from "@pap/ui";
import { type ReactNode, useState } from "react";
import "../../i18n/register-files.ts";
import { errorKey, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentById, requestsOf } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { hasUnsavedFiles } from "../../stores/unsaved-files.ts";
import type { Interleave } from "../../stores/thread-interleave.ts";
import { setPaused } from "./agent-actions.ts";
import { AgentFiles } from "./AgentFiles.tsx";
import { AgentHeader, type AgentTab } from "./AgentHeader.tsx";
import { OpenStatus, PanelSlot } from "./AgentScreenParts.tsx";
import { PendingStrip } from "./PendingStrip.tsx";
import { ComposerLifecycle } from "./LifecycleChip.tsx";
import { PromptChips } from "./PromptChips.tsx";
import { QueueTaskDialog } from "./QueueTaskDialog.tsx";
import { AgentSettingsTab } from "./AgentSettingsTab.tsx";
import { DeleteAgentDialog } from "./DeleteAgentDialog.tsx";
import { QuarantineDialog } from "./QuarantineDialog.tsx";
import { RequestCards } from "./RequestCards.tsx";
import { panelLayout, WIDE_QUERY } from "./status.vm.ts";
import { threadInterleave } from "./thread-plan.tsx";
import { useAgentCards, useMarkRead, useNow, useOpenThread } from "./use-agent-space.ts";
import { useHandOff } from "./use-hand-off.ts";
import { useAgentLifecycle } from "./use-agent-lifecycle.ts";
import { useAgentView } from "./use-agent-view.ts";
import { useCostToday } from "./use-cost-today.ts";

/** What the shell's session screen is given for an agent's thread (features never import each other, M8R77). */
export interface ThreadSlot {
  readonly sessionId: string;
  /** The agent's header, drawn above the session's own. */
  readonly header: ReactNode;
  /** The request cards, pinned above the composer. */
  readonly beforeComposer: ReactNode;
  readonly interleave: Interleave;
}

export interface AgentScreenProps {
  readonly agentId: string;
  readonly avatarStyle: AvatarStyle;
  /** The account's choice (Settings › Agents): the boards' cards, or one line each. */
  readonly eventCards: "cards" | "compact";
  /** The account's choice (Settings › Agents): the status panel starts shown or hidden; the header toggle stays. */
  readonly statusPanel: "shown" | "hidden";
  /** The shell mounts the session screen for the thread with what the agent adds to it. */
  thread(slot: ThreadSlot): ReactNode;
  /** M7's tool preset picker for the agent's own Settings tab, given by the shell (features never import each other). */
  presetField?(value: ToolPreset, onChange: (preset: ToolPreset) => void): ReactNode;
  /** The session explorer rooted at `root` (`/agents/<id>`), given by the shell for the same reason. */
  filesPane?(root: string): ReactNode;
  /** Opens Settings › Agents (the sandbox's page); the agent's own settings are this screen's Settings tab. */
  onOpenSettings(): void;
  /** Opens a session in a tab (a task's). */
  onOpenSession(sessionId: string): void;
  /** Opens a trigger's editor tab; `new:agent:<agentId>` is an empty one for this agent (Task 26). */
  onOpenTrigger(triggerId: string): void;
}

const REQUEST_CLOCK_MS = 30_000;

/**
 * The agent tab (M11R118, board 09 option 1): the header, then the agent's thread as the session screen with the event
 * cards among its rows, the requests that wait for the owner pinned above the composer. The status panel (Task 24) sits beside the thread, in a pane of its own, or in a sheet, by width.
 */
export function AgentScreen(props: AgentScreenProps) {
  const t = useT();
  const view = useAgents((agents) => agents);
  const agent = agentById(view, props.agentId);
  if (agent === undefined)
    return (
      <section data-agent-pane="" className="flex-1 p-s4">
        {view.loaded ? (
          <p role="status" className="text-ui text-muted">
            {t("agentSpace.gone")}
          </p>
        ) : (
          <LoadingLine label={t("agentSpace.loading")} />
        )}
      </section>
    );
  return (
    <AgentSpace
      {...props}
      agent={agent}
      requests={requestsOf(view, props.agentId)}
      cardTick={view.cardTicks[props.agentId] ?? 0}
    />
  );
}

interface SpaceProps extends AgentScreenProps {
  readonly agent: AgentSummary;
  readonly requests: readonly AgentRequestView[];
  readonly cardTick: number;
}

function AgentSpace({
  agent,
  requests,
  cardTick,
  avatarStyle,
  eventCards,
  statusPanel,
  thread,
  presetField,
  filesPane,
  onOpenSettings,
  onOpenSession,
  onOpenTrigger,
}: SpaceProps) {
  const t = useT();
  const locale = useLocale();
  const agentId = agent.id;
  const unusable = agent.quarantined || agent.unreadable;
  const opened = useOpenThread(agentId, unusable);
  const sessionId = opened.state.kind === "ready" ? opened.state.sessionId : null;
  const detail = useAgentView(agentId, `${agent.lastActivityAt}:${agent.name}:${agent.state}`);
  const costToday = useCostToday(agentId, `${agent.lastActivityAt}`);
  const events = useAgentCards(agentId, cardTick);
  const tainted = useSessionStore((state) =>
    sessionId === null ? false : (state.views[sessionId]?.policy.tainted ?? false),
  );
  const lifecycle = useAgentLifecycle(agent, sessionId);
  const now = useNow(REQUEST_CLOCK_MS);
  useMarkRead(agentId, agent.unread, sessionId !== null);
  useHandOff(
    agentId,
    sessionId,
    useAgents((agents) => agents.agents),
  );
  const [queueing, setQueueing] = useState(false);

  const pause = usePendingAction();
  const reset = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const layout = panelLayout(useMediaQuery(WIDE_QUERY), useIsPhone());
  // The setting says how the panel starts, in the column only; the toggle then decides until the layout changes.
  const [asked, setAsked] = useState<boolean | null>(null);
  const panelOpen = asked ?? (layout === "side" && statusPanel === "shown");
  // Thread / Files / Settings (M11R126). Settings can land on the budget group; Quarantine and Delete open their dialogs.
  const [tab, setTab] = useState<AgentTab>("thread");
  const [focus, setFocus] = useState<"budget" | undefined>(undefined);
  const [dialog, setDialog] = useState<"quarantine" | "delete" | null>(null);
  const panelShown = panelOpen && tab === "thread";
  // Files unmounts when another tab opens: its unsaved edits would go with it, so the person is asked first.
  const mayLeaveFiles = () =>
    tab !== "files" || !hasUnsavedFiles(`/agents/${agentId}`) || window.confirm(t("files.edit.discardPane"));
  const openTab = (next: AgentTab) => {
    if (next !== tab && !mayLeaveFiles()) return;
    setFocus(undefined);
    setTab(next);
  };
  const openBudget = () => {
    if (!mayLeaveFiles()) return;
    setAsked(false);
    setFocus("budget");
    setTab("settings");
  };
  const toggleStatus = () => {
    if (tab === "settings") openTab("thread");
    setAsked(tab === "settings" ? true : !panelOpen);
  };
  const fail = (failure: unknown) =>
    setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));

  const togglePause = () =>
    void pause.run(async () => {
      setProblem(null);
      const refusal = await setPaused(agentId, !agent.paused, null);
      if (refusal !== null) setProblem(t(refusal));
    });
  const resetThread = () =>
    void reset.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call("agents.resetThread", { agentId }, { commandId: rpc.newCommandId() });
        setConfirmingReset(false);
        opened.reopen();
      } catch (failure) {
        fail(failure);
      }
    });

  const header = (
    <AgentHeader
      agent={agent}
      view={detail.load.kind === "ready" ? detail.load.agent : null}
      avatarStyle={avatarStyle}
      lifecycle={lifecycle}
      costToday={costToday}
      tainted={tainted}
      pausing={pause.since}
      canReset={sessionId !== null && !agent.quarantined}
      problem={problem}
      onTogglePause={togglePause}
      onReset={() => setConfirmingReset(true)}
      onOpenSettings={() => openTab("settings")}
      onQueueTask={() => setQueueing(true)}
      onQuarantine={() => setDialog("quarantine")}
      onDelete={() => setDialog("delete")}
      tab={{ value: tab, files: true, onChange: openTab }}
      statusToggle={{ open: panelShown, onToggle: toggleStatus }}
      confirm={
        confirmingReset ? (
          <div role="group" aria-label={t("agentSpace.reset.confirm")} className="flex flex-col gap-s2">
            <p className="text-ui text-muted">{t("agentSpace.reset.ask")}</p>
            <div className="flex flex-wrap gap-s2">
              <Button variant="primary" pendingSince={reset.since} onClick={resetThread}>
                {t("agentSpace.reset.confirm")}
              </Button>
              <Button onClick={() => setConfirmingReset(false)}>{t("agentSpace.reset.cancel")}</Button>
            </div>
          </div>
        ) : null
      }
    />
  );

  const frame = (content: ReactNode, contentClass: string) => (
    <section data-agent-pane="" aria-label={agent.name} className="flex min-h-0 min-w-0 flex-1">
      <div
        hidden={panelShown && layout === "pane"}
        className={panelShown && layout === "pane" ? undefined : contentClass}
      >
        {content}
      </div>
      <PanelSlot
        agentId={agentId}
        layout={layout}
        open={panelShown}
        onClose={() => setAsked(false)}
        onOpenSettings={openBudget}
        onOpenSession={onOpenSession}
        onOpenTrigger={onOpenTrigger}
      />
      {queueing ? (
        <QueueTaskDialog
          agentId={agentId}
          agentName={agent.name}
          paused={agent.paused}
          onClose={() => setQueueing(false)}
        />
      ) : null}
      {dialog === "quarantine" ? (
        <QuarantineDialog agent={agent} onClose={() => setDialog(null)} />
      ) : dialog === "delete" ? (
        <DeleteAgentDialog agent={agent} onClose={() => setDialog(null)} />
      ) : null}
    </section>
  );

  if (tab !== "thread")
    return frame(
      <>
        {header}
        {tab === "files" ? (
          filesPane === undefined ? (
            <AgentFiles agentId={agentId} />
          ) : (
            <div data-agent-files-tab="" className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 flex-col">{filesPane(`/agents/${agentId}`)}</div>
              <div className="flex min-h-0 max-h-1/2 shrink-0 flex-col border-t border-border p-s3">
                <AgentFiles agentId={agentId} />
              </div>
            </div>
          )
        ) : (
          <AgentSettingsTab
            agent={agent}
            canReset={sessionId !== null && !agent.quarantined}
            presetField={presetField ?? (() => null)}
            {...(focus === undefined ? {} : { focus })}
            onReset={() => setConfirmingReset(true)}
            onQuarantine={() => setDialog("quarantine")}
            onDelete={() => setDialog("delete")}
          />
        )}
      </>,
      "flex min-h-0 min-w-0 flex-1 flex-col gap-s3 p-s4",
    );

  if (sessionId === null)
    return frame(
      <>
        {header}
        <OpenStatus
          agentId={agentId}
          unusable={unusable ? (agent.quarantined ? "quarantined" : "unreadable") : null}
          state={opened.state}
          onRetry={opened.reopen}
          onOpenSettings={onOpenSettings}
        />
      </>,
      "flex min-w-0 flex-1 flex-col gap-s3 p-s4",
    );

  const inject = (text: string) => useComposerPrefill.getState().push(sessionId, text);
  const dayLabel = (at: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(at);
  const interleave = threadInterleave({
    events,
    mode: eventCards,
    onInject: inject,
    agent: { id: agentId, name: agent.name },
    dayLabel,
  });
  return frame(
    thread({
      sessionId,
      header,
      interleave,
      beforeComposer: (
        <>
          <RequestCards
            agentName={agent.name}
            requests={requests}
            tainted={tainted}
            now={now}
            onProvide={(request) => useSecretDialog.getState().open(request.id)}
          />
          <PendingStrip agentId={agentId} />
          <ComposerLifecycle lifecycle={lifecycle} />
          <PromptChips agentId={agentId} sessionId={sessionId} refreshKey={String(agent.lastActivityAt)} />
        </>
      ),
    }),
    "flex min-h-0 min-w-0 flex-1 flex-col",
  );
}

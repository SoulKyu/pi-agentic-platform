import "./register-lanes-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button, EmptyState, IconButton, IconSplit, Segmented, useIsPhone, InlineError } from "@pap/ui";
import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { laneSessions } from "../../lib/lane-sessions.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { ArchiveDialog } from "./ArchiveDialog.tsx";
import { CheckpointBanner } from "./CheckpointBanner.tsx";
import { LaneHeader } from "./LaneHeader.tsx";
import { LaneNotices } from "./LaneNotices.tsx";
import { LaneSessionMenu } from "./LaneSessionMenu.tsx";
import { headerModel } from "./lane-header.vm.ts";
import { onShowReview, readLayout, writeLayout, type LaneLayout, type RightPane } from "./lane-layout.ts";
import { ScriptLogDialog } from "./ScriptLogDialog.tsx";
import { TaintedConfirm } from "./TaintedConfirm.tsx";
import { useNewSession, useRunSetup } from "./use-lane-actions.ts";

/** The panes the shell builds from the session, changes and terminal features (features never import each other). */
export interface LanePanes {
  chat(sessionId: string, beforeComposer: ReactNode): ReactNode;
  changes(root: string): ReactNode;
  terminal(root: string): ReactNode;
  /** The shell's two-pane splitter. */
  split(props: {
    readonly ratio: number;
    onRatio(ratio: number): void;
    readonly first: ReactNode;
    readonly second: ReactNode;
    readonly label: string;
  }): ReactNode;
  /** The review pane (Task 19): the shell lazy-loads it and adds what only it knows (Open in Files). */
  review?(props: ReviewSlotProps): ReactNode;
  /** Opens the compare tab of the lane's fan-out (§5): the shell decides how a tab opens. */
  openCompare?(fanoutId: string): void;
  /** Slot of Task 20: the commit bar. */
  readonly commitBar?: ReactNode;
}

/** What the lane tab tells the review pane. */
export interface ReviewSlotProps {
  readonly laneId: string;
  readonly worktree: string;
  /** The session the chat shows, and its name. */
  readonly sessionId: string | null;
  readonly sessionLabel: string;
  /** "Send to": brings the chat to the front on that session. */
  onOpenChat(sessionId: string): void;
}

/** The badge keeps what it knew when this fails; an error on it keeps its Retry. */
const refreshPr = (laneId: string): void => {
  getRuntime()
    .rpc.call("lanes.prRefresh", { laneId })
    .catch(() => reportClientIssue("command_failed"));
};

type PhonePane = "chat" | "review" | "terminal";

const RIGHT_OTHER: Record<RightPane, RightPane> = {
  review: "terminal",
  changes: "terminal",
  terminal: "changes",
};

/** The lane tab (board 10): header, notices, then the chat beside a Review / Changes / Terminal pane; one pane on a phone. */
export function LaneBody({ lane, panes }: { readonly lane: LaneView; readonly panes: LanePanes }) {
  const t = useT();
  const phone = useIsPhone();
  const sessions = useShellStore((state) => state.view.sessions);
  const [layout, setLayout] = useState<LaneLayout>(() => readLayout(lane.id));
  const [picked, setPicked] = useState<string | null>(null);
  const [phonePane, setPhonePane] = useState<PhonePane>("chat");
  const [dialog, setDialog] = useState<"log" | "archive" | null>(null);
  const setup = useRunSetup(lane.id);
  const newSession = useNewSession(lane, setPicked);

  // "View diff" from the compare tab while this tab is open: show the Review pane (on a phone, its Review segment).
  useEffect(
    () =>
      onShowReview((laneId, next) => {
        if (laneId !== lane.id) return;
        setLayout(next);
        setPhonePane("review");
      }),
    [lane.id],
  );

  const hasPr = lane.pr !== null;
  // Once when the tab opens on a lane with a pull request (the daemon caches 60 s).
  useEffect(() => {
    if (hasPr) refreshPr(lane.id);
  }, [lane.id, hasPr]);

  const change = (patch: Partial<LaneLayout>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    writeLayout(lane.id, next);
  };

  const own = laneSessions(lane, sessions.values()).sort((a, b) => a.createdAt - b.createdAt);
  const sessionId = picked ?? lane.primarySessionId ?? own[0]?.id ?? null;
  const model = headerModel(lane, sessions.values());
  const shownSession = own.find((session) => session.id === sessionId);

  const chat =
    sessionId === null ? (
      <EmptyState
        title={t("lanes.session.none")}
        purpose={t("lanes.session.nonePurpose")}
        action={
          <Button variant="primary" disabled={newSession.busy} onClick={newSession.start}>
            {t("lanes.action.newSession")}
          </Button>
        }
      />
    ) : (
      panes.chat(sessionId, <CheckpointBanner key={sessionId} laneId={lane.id} sessionId={sessionId} />)
    );
  const rightContent = (pane: RightPane): ReactNode => {
    if (pane === "changes") return panes.changes(lane.worktree);
    if (pane === "terminal") return panes.terminal(lane.worktree);
    if (!panes.review) return <p className="p-s4 text-ui text-muted">{t("lanes.review.soon")}</p>;
    return panes.review({
      laneId: lane.id,
      worktree: lane.worktree,
      sessionId,
      sessionLabel: shownSession ? sessionLabel(shownSession) : "",
      onOpenChat: (id) => {
        setPicked(id);
        setPhonePane("chat");
      },
    });
  };
  const column = (content: ReactNode) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
  );

  let body: ReactNode;
  if (phone) {
    const options = [
      { value: "chat", label: t("lanes.pane.chat") },
      { value: "review", label: t("lanes.pane.review") },
      { value: "terminal", label: t("lanes.pane.term") },
    ] as const;
    body = (
      <>
        <div className="border-b border-border px-s3">
          <Segmented<PhonePane>
            label={t("lanes.pane.phone")}
            labelHidden
            value={phonePane}
            options={options}
            onChange={setPhonePane}
          />
        </div>
        {phonePane === "chat" ? column(chat) : null}
        {phonePane === "review" ? column(rightContent("review")) : null}
        {phonePane === "terminal" ? column(rightContent("terminal")) : null}
        {phonePane === "review" ? panes.commitBar : null}
      </>
    );
  } else {
    const right = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-s2 border-b border-border px-s3">
          <Segmented
            label={t("lanes.pane.right")}
            labelHidden
            value={layout.right}
            options={[
              { value: "review", label: t("lanes.pane.review") },
              { value: "changes", label: t("lanes.pane.changes") },
              { value: "terminal", label: t("lanes.pane.terminal") },
            ]}
            onChange={(right) => change({ right })}
          />
          <IconButton
            icon={IconSplit}
            size="sm"
            label={layout.split ? t("lanes.pane.unsplit") : t("lanes.pane.split")}
            aria-pressed={layout.split}
            onClick={() => change({ split: !layout.split })}
          />
        </div>
        {column(rightContent(layout.right))}
        {layout.split ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-border">
            {rightContent(RIGHT_OTHER[layout.right])}
          </div>
        ) : null}
        {panes.commitBar}
      </div>
    );
    body = panes.split({
      ratio: layout.ratio,
      onRatio: (ratio) => change({ ratio }),
      first: column(chat),
      second: right,
      label: t("lanes.pane.separator"),
    });
  }

  const title = lane.title || lane.branch;
  const fanoutId = lane.fanoutId;
  const openCompare = panes.openCompare;
  return (
    <section aria-label={title} className="flex min-h-0 w-full flex-1 flex-col">
      <LaneHeader
        title={title}
        model={model}
        busy={{ runSetup: setup.busy, newSession: newSession.busy }}
        sessionMenu={<LaneSessionMenu lane={lane} current={sessionId} onPick={setPicked} />}
        actions={{
          onSetupLog: () => setDialog("log"),
          onRunSetup: () => setup.run(),
          onNewSession: newSession.start,
          onArchive: () => setDialog("archive"),
          onRetryPr: () => refreshPr(lane.id),
          onOpenCompare: fanoutId !== null && openCompare !== undefined ? () => openCompare(fanoutId) : null,
        }}
      />
      <div className="flex flex-col gap-s2 px-s4 py-s2 empty:hidden">
        <LaneNotices laneId={lane.id} notices={lane.notices} onStartSession={newSession.start} />
        {setup.tainted ? (
          <TaintedConfirm busy={setup.busy} onConfirm={() => setup.run(true)} onCancel={setup.cancel} />
        ) : null}
        {setup.problem !== null ? <InlineError announce="action">{t(setup.problem)}</InlineError> : null}
        {newSession.problem !== null ? (
          <InlineError announce="action">{t(newSession.problem)}</InlineError>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {dialog === "log" ? <ScriptLogDialog laneId={lane.id} onClose={() => setDialog(null)} /> : null}
      {dialog === "archive" ? <ArchiveDialog lane={lane} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

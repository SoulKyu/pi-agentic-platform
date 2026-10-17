import "./register-session-catalog.ts";
import "./register-policy-catalog.ts";
import {
  Banner,
  Button,
  IconButton,
  IconClose,
  RunStatusChip,
  type RunStatus,
  type ToolDetail,
} from "@pap/ui";
import { AnsiText, plainText, StatusBar, Widgets } from "@pap/ui/extensions";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { codedServerText } from "../../i18n/server-text.ts";
import { getRuntime } from "../../runtime/index.ts";
import "../../i18n/register-sidebar.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import type { Interleave } from "../../stores/thread-interleave.ts";
import { noticeKey, toastLiveInfo, useDismissedNotices } from "./notice-toast.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import "./register-server-catalog.ts";
import { Composer } from "./Composer.tsx";
import { CrashBanner } from "./CrashBanner.tsx";
import { LimitChip } from "./LimitChip.tsx";
import { SessionPolicy } from "./SessionPolicy.tsx";
import { useAnnouncer } from "./announce.ts";
import { SessionActions } from "./SessionActions.tsx";
import { DialogList } from "./dialogs/DialogList.tsx";
import { CustomPanel } from "./CustomPanel.tsx";
import { codeText, failureText } from "./failure.ts";
import { statusCells } from "./status-cells.ts";
import { useStructural } from "./use-action.ts";
import { Transcript } from "./Transcript.tsx";
import { TrustBanner } from "../trust/TrustBanner.tsx";

/** The chip says what the run needs from you before it says how the process is. */
function runStatusOf(view: SessionView): RunStatus {
  if (view.status !== "cold" && view.dialogs.length > 0) return "needs-input";
  // A stopped worker is a session that is settled: a quota limit is the `usage` stream's to say (LimitChip).
  return view.status === "idle" || view.status === "cold" ? "settled" : "working";
}

export function SessionScreen({
  sessionId,
  toolDetail,
  beforeComposer,
  header,
  interleave,
}: {
  sessionId: string;
  beforeComposer?: ReactNode;
  /** An agent thread's own header, above the session's (M11R118), and the cards its transcript interleaves. */
  header?: ReactNode;
  interleave?: Interleave;
  /** The account's tool card detail (Settings › Appearance), given by the pane that hosts the screen. */
  toolDetail?: ToolDetail;
}) {
  const t = useT();
  const locale = useLocale();
  const runtime = getRuntime();
  const view = useSessionStore((state) => state.views[sessionId]) ?? EMPTY_VIEW;
  const dismissedNotices = useDismissedNotices((state) => state.keys);
  const dismissNotice = useDismissedNotices((state) => state.dismiss);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // One feed per session id: the events build the view in the store, not in this component.
  useEffect(
    () => feedSession(runtime.subscriptions, sessionId, (code) => setError(codeText(code)), toastLiveInfo),
    [runtime, sessionId],
  );

  // A dialog closed while others were hidden: one fresh snapshot lets the hidden ones reach this client (M4R111).
  useEffect(() => {
    if (view.staleDialogs) runtime.subscriptions.resync("session", sessionId);
  }, [view.staleDialogs, runtime, sessionId]);

  // A status button's command goes out as a prompt; its failure shows like any other (the bar is disabled while busy).
  const commandInFlight = useRef(false);
  const runCommand = (command: string) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setError(null);
    runtime.rpc
      .call("sessions.prompt", { sessionId, text: command }, { commandId: runtime.rpc.newCommandId() })
      .catch((failure: unknown) => setError(failureText(failure)))
      .finally(() => {
        commandInFlight.current = false;
      });
  };
  // Tab in the composer goes to this screen's own panel (two screens can be mounted at once).
  const screenRef = useRef<HTMLElement | null>(null);
  const focusPanel = () => {
    const input = screenRef.current?.querySelector<HTMLElement>("[data-terminal-input] textarea");
    input?.focus();
    return input != null;
  };
  const structural = useStructural();
  const [edit, setEdit] = useState<{ sessionId: string; n: number; text: string } | null>(null);
  const editHere = (text: string) => setEdit((was) => ({ sessionId, n: (was?.n ?? 0) + 1, text }));
  const title = view.title === null ? "" : plainText(view.title).trim();
  const announcer = useAnnouncer(view);

  return (
    <section
      ref={screenRef}
      data-session-screen={sessionId}
      className="flex min-h-0 w-full flex-1 flex-col gap-s3 p-s4"
    >
      {header}
      <header className="flex flex-wrap items-center gap-s2">
        <div className="flex min-w-0 flex-1 items-baseline gap-s3">
          {view.name ? (
            <h1 data-session-name className="min-w-0 truncate text-ui font-semibold text-fg">
              {view.name}
            </h1>
          ) : null}
          {title ? (
            <span data-session-title className="min-w-0 truncate font-mono text-ui text-muted">
              {title}
            </span>
          ) : null}
        </div>
        <RunStatusChip
          status={runStatusOf(view)}
          label={t(
            runStatusOf(view) === "needs-input"
              ? "session.status.needsInput"
              : `session.status.${view.status}`,
          )}
        />
        <LimitChip sessionId={sessionId} />
        <SessionPolicy
          key={`policy:${sessionId}`}
          sessionId={sessionId}
          policy={view.policy}
          cwd={view.cwd}
        />
        <SessionActions
          key={`actions:${sessionId}`}
          sessionId={sessionId}
          view={view}
          track={structural.track}
          blocked={structural.active}
        />
      </header>
      {view.unreadable ? (
        <p role="alert" className="border-l-2 border-err px-s3 py-s2 text-ui text-err">
          {t("sessions.unreadable")}
        </p>
      ) : null}
      {view.crash && view.status === "cold" ? <CrashBanner sessionId={sessionId} crash={view.crash} /> : null}
      {view.outsideWrite && dismissed !== view.generation ? (
        <Banner
          tone="capacity"
          title={t("session.outsideWrite.title")}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setDismissed(view.generation)}>
              {t("session.outsideWrite.dismiss")}
            </Button>
          }
        >
          {t("session.outsideWrite.body")}
        </Banner>
      ) : null}
      <TrustBanner sessionId={sessionId} cwd={view.cwd} trust={view.loadout?.projectTrust ?? null} />
      <CustomPanel key={`panel:${sessionId}`} sessionId={sessionId} panels={view.panels} />
      <Transcript
        key={`transcript:${sessionId}`}
        sessionId={sessionId}
        view={view}
        toolDetail={toolDetail ?? "compact"}
        interleave={interleave}
        rowActions={{
          track: structural.track,
          busy: structural.active,
          onEdit: editHere,
          announce: announcer.say,
        }}
      />
      <DialogList
        key={`dialogs:${sessionId}`}
        sessionId={sessionId}
        dialogs={view.dialogs}
        hidden={view.hiddenDialogs}
      />
      {view.notices.map((notice, index) =>
        notice.level === "info" || dismissedNotices.has(noticeKey(sessionId, notice)) ? null : (
          <p
            key={`${index}:${notice.text}`}
            data-notice
            role={notice.level === "error" ? "alert" : undefined}
            className={`flex items-start gap-s2 text-ui ${notice.level === "error" ? "text-err" : "text-muted"}`}
          >
            <span className="min-w-0 flex-1">
              {notice.source === "extension" ? (
                <>
                  <span className="mr-s2 label-hud text-muted">{t("source.extension")}</span>
                  <AnsiText text={notice.text} />
                </>
              ) : (
                codedServerText(notice, locale)
              )}
            </span>
            <IconButton
              icon={IconClose}
              label={t("ui.dismiss")}
              onClick={() => dismissNotice(noticeKey(sessionId, notice))}
            />
          </p>
        ),
      )}
      {error ? (
        <p role="alert" className="text-ui text-attn">
          {error}
        </p>
      ) : null}
      <Widgets widgets={view.widgets} placement="aboveEditor" />
      {beforeComposer}
      <Composer
        key={sessionId}
        sessionId={sessionId}
        view={view}
        onTabToPanel={focusPanel}
        injected={edit?.sessionId === sessionId ? edit : null}
        structuralBusy={structural.active}
      />
      <Widgets widgets={view.widgets} placement="belowEditor" />
      <StatusBar
        cells={statusCells(view.statuses)}
        label={t("status.label")}
        sourceLabel={t("source.extension")}
        busy={["running", "starting", "releasing"].includes(view.status)}
        onCommand={runCommand}
      />
      <p role="status" aria-live="polite" data-announcer className="sr-only">
        {announcer.text}
      </p>
    </section>
  );
}

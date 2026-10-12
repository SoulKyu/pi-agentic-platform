import { cn, FOCUS_RING, RunStatusChip, type RunStatus, type ToolDetail } from "@pap/ui";
import { AnsiText, plainText, StatusBar, Widgets } from "@pap/ui/extensions";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { codedServerText } from "../../i18n/server-text.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import "./register-server-catalog.ts";
import { SessionRules } from "./AlwaysRules.tsx";
import { Composer } from "./Composer.tsx";
import { useAnnouncer } from "./announce.ts";
import { SessionActions } from "./SessionActions.tsx";
import { DialogList } from "./dialogs/DialogList.tsx";
import { CustomPanel } from "./CustomPanel.tsx";
import { codeText, failureText } from "./failure.ts";
import { statusCells } from "./status-cells.ts";
import { useStructural } from "./use-action.ts";
import { Transcript } from "./Transcript.tsx";

/** The chip says what the run needs from you before it says how the process is. */
function runStatusOf(view: SessionView): RunStatus {
  if (view.status !== "cold" && view.dialogs.length > 0) return "needs-input";
  if (view.status === "cold") return "limited";
  return view.status === "idle" ? "settled" : "working";
}

export function SessionScreen({
  sessionId,
  toolDetail,
}: {
  sessionId: string;
  /** The account's tool card detail (Settings › Appearance), given by the pane that hosts the screen. */
  toolDetail?: ToolDetail;
}) {
  const t = useT();
  const locale = useLocale();
  const runtime = getRuntime();
  const view = useSessionStore((state) => state.views[sessionId]) ?? EMPTY_VIEW;
  const [error, setError] = useState<string | null>(null);
  // One feed per session id: the events build the view in the store, not in this component.
  useEffect(
    () => feedSession(runtime.subscriptions, sessionId, (code) => setError(codeText(code))),
    [runtime, sessionId],
  );

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
      <header className="flex items-center justify-between">
        <Link to="/" className={cn("text-agent underline", FOCUS_RING)}>
          {t("sessions.title")}
        </Link>
        {view.name ? (
          <h1 data-session-name className="min-w-0 flex-1 truncate px-3 text-ui font-semibold text-fg">
            {view.name}
          </h1>
        ) : null}
        {title ? (
          <span data-session-title className="min-w-0 truncate px-3 font-mono text-ui text-muted">
            {title}
          </span>
        ) : null}
        <RunStatusChip
          status={runStatusOf(view)}
          label={t(
            runStatusOf(view) === "needs-input"
              ? "session.status.needsInput"
              : `session.status.${view.status}`,
          )}
        />
      </header>
      {view.unreadable ? (
        <p role="alert" className="border-l-2 border-err px-3 py-2 text-ui text-err">
          {t("sessions.unreadable")}
        </p>
      ) : null}
      <SessionActions
        key={`actions:${sessionId}`}
        sessionId={sessionId}
        view={view}
        track={structural.track}
        blocked={structural.active}
      />
      <SessionRules key={`rules:${sessionId}`} sessionId={sessionId} />
      <CustomPanel key={`panel:${sessionId}`} sessionId={sessionId} panels={view.panels} />
      <Transcript
        key={`transcript:${sessionId}`}
        sessionId={sessionId}
        view={view}
        toolDetail={toolDetail ?? "compact"}
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
      {view.notices.map((notice, index) => (
        <p
          key={`${index}:${notice.text}`}
          data-notice
          role={notice.level === "error" ? "alert" : undefined}
          className={notice.level === "error" ? "text-ui text-err" : "text-ui text-muted"}
        >
          {notice.source === "extension" ? (
            <>
              <span className="mr-2 font-mono text-label uppercase tracking-label text-muted">
                {t("source.extension")}
              </span>
              <AnsiText text={notice.text} />
            </>
          ) : (
            codedServerText(notice, locale)
          )}
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-ui text-attn">
          {error}
        </p>
      ) : null}
      <Widgets widgets={view.widgets} placement="aboveEditor" />
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

import { cn, FOCUS_RING } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { Composer } from "./Composer.tsx";
import { DialogList } from "./dialogs/DialogList.tsx";
import { plainText } from "./ansi.ts";
import { AnsiText } from "./AnsiText.tsx";
import { CustomPanel } from "./CustomPanel.tsx";
import { codeText, failureText } from "./failure.ts";
import { StatusBar } from "./StatusBar.tsx";
import { Transcript } from "./Transcript.tsx";
import { Widgets } from "./Widgets.tsx";

export function SessionScreen({ sessionId }: { sessionId: string }) {
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
  const title = view.title === null ? "" : plainText(view.title).trim();

  return (
    <main ref={screenRef} className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 p-4">
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
        <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
          {t(`session.status.${view.status}`)}
        </span>
      </header>
      {view.unreadable ? (
        <p role="alert" className="border-l-2 border-error px-3 py-2 text-ui text-error">
          {t("sessions.unreadable")}
        </p>
      ) : null}
      <CustomPanel key={`panel:${sessionId}`} sessionId={sessionId} panels={view.panels} />
      <Transcript key={`transcript:${sessionId}`} sessionId={sessionId} view={view} />
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
          className={notice.level === "error" ? "text-ui text-error" : "text-ui text-muted"}
        >
          {notice.source === "extension" ? (
            <>
              <span className="mr-2 font-mono text-label uppercase tracking-label text-muted">
                {t("source.extension")}
              </span>
              <AnsiText text={notice.text} />
            </>
          ) : (
            notice.text
          )}
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
      <Widgets widgets={view.widgets} placement="aboveEditor" />
      <Composer key={sessionId} sessionId={sessionId} view={view} onTabToPanel={focusPanel} />
      <Widgets widgets={view.widgets} placement="belowEditor" />
      <StatusBar
        statuses={view.statuses}
        busy={["running", "starting", "releasing"].includes(view.status)}
        onCommand={runCommand}
      />
    </main>
  );
}

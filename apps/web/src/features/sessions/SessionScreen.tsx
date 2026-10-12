import type { DialogResponse } from "@pap/contracts";
import { ApprovalCard, Button, cn, FOCUS_RING } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { approvalDetail } from "./approval-detail.ts";
import { Composer } from "./Composer.tsx";
import { codeText, failureText } from "./failure.ts";
import { Transcript } from "./Transcript.tsx";

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const runtime = getRuntime();
  const view = useSessionStore((state) => state.views[sessionId]) ?? EMPTY_VIEW;
  const [error, setError] = useState<string | null>(null);
  // Counts the answers to a dialog that could not be delivered: it keys the card, see `answer`.
  const [refused, setRefused] = useState<Readonly<Record<string, number>>>({});

  // One feed per session id: the events build the view in the store, not in this component.
  useEffect(
    () => feedSession(runtime.subscriptions, sessionId, (code) => setError(codeText(code))),
    [runtime, sessionId],
  );

  const fail = (failure: unknown) => setError(failureText(failure));
  const answer = (dialogId: string, response: DialogResponse) => {
    setError(null);
    runtime.rpc
      .call("sessions.respondDialog", { sessionId, dialogId, response })
      .catch((failure: unknown) => {
        fail(failure);
        // The card turned its buttons off on the first click and the dialog is still open: a new key
        // builds a new card, so the owner can answer again instead of leaving the agent waiting.
        setRefused((current) => ({ ...current, [dialogId]: (current[dialogId] ?? 0) + 1 }));
      });
  };

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className={cn("text-agent underline", FOCUS_RING)}>
          {t("sessions.title")}
        </Link>
        {view.name ? (
          <h1 data-session-name className="min-w-0 flex-1 truncate px-3 text-ui font-semibold text-fg">
            {view.name}
          </h1>
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
      <Transcript key={`transcript:${sessionId}`} sessionId={sessionId} view={view} />
      {view.dialogs.map((dialog) =>
        dialog.method === "confirm" || dialog.method === "approval" ? (
          <ApprovalCard
            key={`${dialog.id}:${refused[dialog.id] ?? 0}`}
            title={t("approval.title")}
            detail={approvalDetail(dialog)}
            allowLabel={t("approval.allow")}
            denyLabel={t("approval.deny")}
            // Until Task 26 the policy's card offers the two answers M1's card has; an extension's confirm keeps `confirmed`.
            onAnswer={(allowed) =>
              answer(
                dialog.id,
                dialog.method === "approval" ? { answer: allowed ? "once" : "deny" } : { confirmed: allowed },
              )
            }
          />
        ) : (
          <div key={dialog.id} className="flex flex-col gap-2 rounded-sm border border-attention p-3">
            <p role="alert" className="text-ui text-fg">
              {t("dialog.unsupported")}
            </p>
            <div>
              <Button onClick={() => answer(dialog.id, { cancelled: true })}>{t("dialog.cancel")}</Button>
            </div>
          </div>
        ),
      )}
      {view.notices.map((notice, index) => (
        <p
          key={`${index}:${notice.text}`}
          role={notice.level === "error" ? "alert" : undefined}
          className={notice.level === "error" ? "text-ui text-error" : "text-ui text-muted"}
        >
          {notice.text}
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
      <Composer key={sessionId} sessionId={sessionId} view={view} />
    </main>
  );
}

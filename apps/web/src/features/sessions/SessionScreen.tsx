import type { DialogResponse } from "@pap/contracts";
import { ApprovalCard, Button, cn, FOCUS_RING, Message, TextField } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { approvalDetail } from "./approval-detail.ts";
import { codeText, failureText, outcomeUnknown } from "./failure.ts";
import { transcriptItems } from "./transcript.vm.ts";
import { useStickToBottom } from "./use-stick-to-bottom.ts";

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const runtime = getRuntime();
  const view = useSessionStore((state) => state.views[sessionId]) ?? EMPTY_VIEW;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Counts the answers to a dialog that could not be delivered: it keys the card, see `answer`.
  const [refused, setRefused] = useState<Readonly<Record<string, number>>>({});
  const items = transcriptItems(view);
  const [attachList, onListScroll] = useStickToBottom(`${items.length}:${items.at(-1)?.text.length ?? 0}`);

  // One feed per session id: the events build the view in the store, not in this component.
  useEffect(
    () => feedSession(runtime.subscriptions, sessionId, (code) => setError(codeText(code))),
    [runtime, sessionId],
  );

  const fail = (failure: unknown) => setError(failureText(failure));
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    setError(null);
    runtime.rpc
      .call("sessions.prompt", {
        sessionId,
        text: message,
        ...(view.status === "running" ? { streamingBehavior: "followUp" as const } : {}),
      })
      .catch((failure: unknown) => {
        fail(failure);
        if (!outcomeUnknown(failure)) setText((current) => (current === "" ? message : current));
      });
  };
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
        <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
          {t(`session.status.${view.status}`)}
        </span>
      </header>
      <ol ref={attachList} onScroll={onListScroll} className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {items.map((item, index) =>
          item.failure ? (
            <li
              key={item.key}
              data-failure
              role={index === items.length - 1 ? "alert" : undefined}
              className="border-l-2 border-error px-3 py-2 text-ui text-error"
            >
              <p className="font-mono text-label font-semibold uppercase tracking-label">
                {t("session.failure")}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words">{item.text}</p>
            </li>
          ) : (
            <li key={item.key}>
              <Message author={item.author} label={t(`author.${item.author}`)}>
                {item.text}
              </Message>
            </li>
          ),
        )}
      </ol>
      {view.dialogs.map((dialog) =>
        dialog.method === "confirm" ? (
          <ApprovalCard
            key={`${dialog.id}:${refused[dialog.id] ?? 0}`}
            title={t("approval.title")}
            detail={approvalDetail(dialog)}
            allowLabel={t("approval.allow")}
            denyLabel={t("approval.deny")}
            onAnswer={(confirmed) => answer(dialog.id, { confirmed })}
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
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <TextField
          label={t("session.composer")}
          value={text}
          onChange={setText}
          multiline
          name="message"
          onSubmitShortcut={send}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={text.trim() === ""}>
            {t("session.send")}
          </Button>
          {view.status === "running" ? (
            <Button
              variant="secondary"
              onClick={() => {
                runtime.rpc.call("sessions.abort", { sessionId }).catch(fail);
              }}
            >
              {t("session.stop")}
            </Button>
          ) : null}
        </div>
      </form>
    </main>
  );
}

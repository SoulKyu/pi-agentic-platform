import type { ForkPoint } from "@pap/contracts";
import { Button, Message } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { deviceStorage, saveDraft } from "../../stores/drafts.ts";
import { BranchSwitcher } from "./BranchSwitcher.tsx";
import { branchChoicesFor } from "./branches.vm.ts";
import { useAction, type Track } from "./use-action.ts";
import type { MessageItem, PartialItem, SummaryItem } from "./transcript.vm.ts";

function Thinking({ text }: { text: string }) {
  return (
    <details className="mb-1 text-muted">
      <summary className="cursor-pointer font-mono text-label uppercase tracking-label">
        {t("sessions.transcript.thinking")}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-ui">{text}</p>
    </details>
  );
}

/** What a user row needs to offer "Fork from here" and "Edit from here". */
export interface RowActions {
  readonly sessionId: string;
  /** The agent works, or another structural call of the screen is in flight: both buttons wait. */
  readonly blocked: boolean;
  readonly track: Track;
  /** The text "Edit from here" puts in the composer. */
  readonly onEdit: (text: string) => void;
  /** The session's fork points, for the branch switcher of a user row. */
  readonly branches?: readonly ForkPoint[];
}

function RowButtons({ entryId, actions }: { entryId: string; actions: RowActions }) {
  const runtime = getRuntime();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const fork = useAction(actions.track, setError);
  const edit = useAction(actions.track, setError);
  const { sessionId } = actions;
  const switchBranch = useAction(actions.track, setError);
  const wait = actions.blocked || fork.busy || edit.busy || switchBranch.busy;
  const choices = branchChoicesFor(actions.branches ?? [], entryId);
  return (
    <div className="mt-1 flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {choices ? (
          <BranchSwitcher
            choices={choices}
            disabled={wait}
            onGo={(targetId) =>
              void switchBranch.run(() =>
                runtime.rpc.call(
                  "sessions.navigate",
                  { sessionId, targetId },
                  { commandId: runtime.rpc.newCommandId() },
                ),
              )
            }
          />
        ) : null}
        <Button
          disabled={wait}
          onClick={() =>
            void fork.run(async () => {
              const forked = await runtime.rpc.call(
                "sessions.fork",
                { sessionId, entryId },
                { commandId: runtime.rpc.newCommandId() },
              );
              saveDraft(deviceStorage(), forked.sessionId, forked.text);
              await navigate({ to: "/s/$sessionId", params: { sessionId: forked.sessionId } });
            })
          }
        >
          {fork.slow ? t("actions.working") : t("row.fork")}
        </Button>
        <Button
          disabled={wait}
          onClick={() =>
            void edit.run(async () => {
              const moved = await runtime.rpc.call(
                "sessions.navigate",
                { sessionId, targetId: entryId },
                { commandId: runtime.rpc.newCommandId() },
              );
              if (!moved.cancelled && moved.editorText !== undefined) actions.onEdit(moved.editorText);
            })
          }
        >
          {edit.slow ? t("actions.working") : t("row.edit")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A message, or the reply being written: plain text, the thinking folded above it; your own rows can fork or be edited. */
export function MessageRow({ item, actions }: { item: MessageItem | PartialItem; actions?: RowActions }) {
  const author = item.kind === "partial" ? "agent" : item.author;
  const entryId = item.kind === "message" && author === "you" ? item.entryId : null;
  return (
    <>
      <Message author={author} label={t(`author.${author}`)}>
        {item.thinking ? <Thinking text={item.thinking} /> : null}
        {item.text}
      </Message>
      {actions && entryId !== null ? <RowButtons entryId={entryId} actions={actions} /> : null}
    </>
  );
}

/** A compaction or a branch summary, folded: its text is what the model was given in place of the rows. */
export function SummaryRow({ item }: { item: SummaryItem }) {
  const title =
    item.variant === "compaction"
      ? t("sessions.transcript.compacted", { tokens: item.tokensBefore ?? 0 })
      : t("sessions.transcript.branchSummary");
  return (
    <details data-summary={item.variant} className="border-l-2 border-line bg-bg px-3 py-2 text-muted">
      <summary className="cursor-pointer font-mono text-label uppercase tracking-label">{title}</summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-ui">{item.text}</p>
    </details>
  );
}

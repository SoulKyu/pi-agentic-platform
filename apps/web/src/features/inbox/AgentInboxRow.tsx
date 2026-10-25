import type { InboxItem } from "@pap/contracts";
import {
  Avatar,
  type AvatarStyle,
  Button,
  Chip,
  type ChipTone,
  cn,
  FOCUS_RING,
  usePendingAction,
  InlineError,
} from "@pap/ui";
import { useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { isOpen } from "./inbox.vm.ts";
import "../../i18n/register-inbox.ts";

/** Hidden characters (bidi, zero-width, controls) are written out of the agent's text, never drawn. */
const HIDDEN = /\p{Cc}|[\p{Cf}\p{Zl}\p{Zp}]/gu;

interface KindWords {
  readonly line: MessageKey;
  readonly chip: MessageKey | null;
  readonly tone: ChipTone;
}

/** pap's own sentence per kind; a kind this build does not know reads as a plain update. */
const KINDS: Readonly<Record<string, KindWords>> = {
  agent_approve: { line: "inbox.agent.line.approve", chip: "inbox.agent.kind.approve", tone: "att" },
  secret_request: { line: "inbox.agent.line.secret", chip: "inbox.agent.kind.secret", tone: "att" },
  agent_reply: { line: "inbox.agent.line.reply", chip: "inbox.agent.kind.reply", tone: "run" },
  delegation_done: { line: "inbox.agent.line.delegation", chip: "inbox.agent.kind.delegation", tone: "ok" },
  agent_notify: { line: "inbox.agent.line.notify", chip: "inbox.agent.kind.notify", tone: "mut" },
  agent_egress: { line: "inbox.agent.line.egress", chip: "inbox.agent.kind.egress", tone: "att" },
};
const OTHER: KindWords = { line: "inbox.agent.line.other", chip: null, tone: "mut" };

/** One answer at a time, its failure in words under the buttons. */
function useAnswer() {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (call: (rpc: ReturnType<typeof getRuntime>["rpc"]) => Promise<unknown>) =>
    void pending.run(async () => {
      setProblem(null);
      try {
        await call(getRuntime().rpc);
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return { since: pending.since, problem, run };
}

function Buttons({
  item,
  name,
  requestId,
}: {
  readonly item: InboxItem;
  readonly name: string;
  readonly requestId: string;
}) {
  const t = useT();
  const answer = useAnswer();
  const approval = (approved: boolean) =>
    answer.run((rpc) =>
      rpc.call("agents.answerApproval", { requestId, approved }, { commandId: rpc.newCommandId() }),
    );
  const decline = () =>
    answer.run((rpc) => rpc.call("secrets.declineRequest", { requestId }, { commandId: rpc.newCommandId() }));
  return (
    <div className="flex flex-col gap-s1 px-s3 pb-s2">
      <div role="group" aria-label={t("inbox.agent.actions", { name })} className="flex flex-wrap gap-s2">
        {item.kind === "agent_approve" ? (
          <>
            <Button size="sm" pendingSince={answer.since} onClick={() => approval(false)}>
              {t("inbox.agent.deny")}
            </Button>
            <Button size="sm" variant="primary" pendingSince={answer.since} onClick={() => approval(true)}>
              {t("inbox.agent.approve")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" pendingSince={answer.since} onClick={decline}>
              {t("inbox.agent.decline")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => useSecretDialog.getState().open(requestId)}>
              {t("inbox.agent.provide")}
            </Button>
          </>
        )}
      </div>
      {answer.problem !== null ? <InlineError announce="action">{answer.problem}</InlineError> : null}
    </div>
  );
}

export interface AgentInboxRowProps {
  readonly item: InboxItem;
  readonly now: number;
  readonly avatarStyle: AvatarStyle;
  onPick(item: InboxItem): void;
}

/**
 * An Inbox line an agent raised (M11R129): its avatar, pap's sentence for the kind, the agent's `detail` as untrusted text,
 * the age. A question that waits carries its buttons, which make the same calls as the agent tab's request cards.
 */
export function AgentInboxRow({ item, now, avatarStyle, onPick }: AgentInboxRowProps) {
  const t = useT();
  const agent = useAgents((view) => (item.agentId === null ? undefined : agentById(view, item.agentId)));
  const words = KINDS[item.kind] ?? OTHER;
  const name = agent?.name ?? t("inbox.agent.someone");
  const open = isOpen(item);
  const unread = item.readAt === null;
  const detail = item.detail?.replace(HIDDEN, "") ?? "";
  const kindOfButtons = item.kind === "agent_approve" || item.kind === "secret_request";
  return (
    <li className="border-b border-border last:border-b-0">
      <div className={cn("border-l-2", open ? "border-l-attn bg-attn-tint" : "border-l-transparent")}>
        <button
          type="button"
          data-slot="inbox-row"
          data-item-id={item.id}
          data-unread={unread ? "true" : undefined}
          onClick={() => onPick(item)}
          className={cn(
            "flex w-full items-start gap-s2 px-s3 py-s2 text-left pointer-coarse:min-h-11",
            FOCUS_RING,
          )}
        >
          <Avatar initials={agent?.initials ?? "?"} name={name} avatarStyle={avatarStyle} />
          <span className="flex min-w-0 flex-1 flex-col gap-s1">
            <span
              data-row-title=""
              className={cn("break-words text-ui", unread ? "font-semibold text-fg" : "text-muted")}
            >
              {t(words.line, { name })}
            </span>
            {detail === "" ? null : (
              <>
                <span className="sr-only">{t("inbox.agent.writtenBy")}</span>
                <span data-row-detail="" className="break-words font-mono text-code text-muted">
                  {detail}
                </span>
              </>
            )}
            <span className="flex flex-wrap items-center gap-s2">
              {words.chip === null ? null : <Chip tone={words.tone} label={t(words.chip)} />}
              <span className="font-mono text-label text-muted tabular-nums">
                {formatAge(now, item.createdAt, t)}
              </span>
              {unread ? <span className="sr-only">{t("inbox.unread")}</span> : null}
            </span>
          </span>
        </button>
        {open && kindOfButtons && item.refId !== null ? (
          <Buttons item={item} name={name} requestId={item.refId} />
        ) : null}
      </div>
    </li>
  );
}

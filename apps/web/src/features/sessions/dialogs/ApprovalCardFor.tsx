import type { AlwaysScope, Dialog, DialogResponse } from "@pap/contracts";
import {
  type ApprovalAnswer as UiApprovalAnswer,
  ApprovalCard,
  Button,
  Chip,
  cn,
  FOCUS_RING,
  useIsPhone,
} from "@pap/ui";
import { useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { splitApproval } from "../approval-detail.ts";
import "../../../i18n/register-inbox.ts";
import { visibleName } from "../../../lib/visible-name.ts";
import { useInboxStore } from "../../../stores/inbox-store.ts";
import "../register-policy-catalog.ts";
import { AlwaysScopeChoice, scopesOffered } from "./AlwaysScopeChoice.tsx";
import { MarkLocal } from "./MarkLocal.tsx";
import { TaintCauseLine } from "./TaintCauseLine.tsx";
import { withoutSessionCd } from "./session-cd.ts";
import { timeoutLine } from "./request-frame.tsx";
import { plain } from "./untrusted.ts";
import { ExpandToggle, useClipped } from "./use-clipped.tsx";

const BODY_LIMITS = { lines: 200, chars: 4000 } as const;
const HEADER_LIMITS = { lines: 2, chars: 400 } as const;
const QUESTION_LIMITS = { lines: 3, chars: 300 } as const;

const uiAnswers = (answers: Dialog["answers"]): UiApprovalAnswer[] =>
  answers !== undefined && answers.length > 0 ? [...answers] : ["deny"];

/** A clipped text that has been expanded can scroll: it becomes a named region the keyboard can reach. */
const scrollArea = (expanded: boolean, name: string) =>
  expanded ? ({ role: "region", tabIndex: 0, "aria-label": name } as const) : {};

/**
 * Maps the policy's dialog onto the approval card; the card itself knows nothing of dialogs (M2R128). The policy's
 * words are untrusted: stripped of invisible characters and clipped until the owner expands them. One card is one
 * request: the list keys it by request id and attempt, and the card answers once.
 */
export function ApprovalCardFor(props: {
  readonly dialog: Dialog;
  /** The session the card belongs to: a task's session names the trigger that started it. */
  readonly sessionId?: string;
  /** The session's folder: a bash command that starts with `cd` into it shows without that prefix (display only). */
  readonly cwd?: string;
  onAnswer(response: DialogResponse): void;
}) {
  const { dialog } = props;
  const t = useT();
  // On a phone the card fills its row with 44 px answers (decision 32: the card a tapped notification opens).
  const phone = useIsPhone();
  // The eager inbox store's unresolved question of this session: its trigger name is the owner's own text, shown capped.
  const trigger = useInboxStore((state) =>
    props.sessionId === undefined
      ? null
      : (state.view.items.find(
          (item) =>
            item.kind === "task_needs_input" &&
            item.toHandle &&
            item.resolvedAt === null &&
            item.sessionId === props.sessionId,
        )?.triggerName ?? null),
  );
  const [scope, setScope] = useState<AlwaysScope>("exact");
  const scopes = scopesOffered(dialog);
  const question = useClipped(dialog.title, QUESTION_LIMITS);
  const { header, body } = splitApproval(plain(dialog.message ?? ""));
  const headerText = useClipped(header ?? "", HEADER_LIMITS);
  // Display only (decision 117, A3): the answer, the policy and the audit always see the full command.
  const [fullCommand, setFullCommand] = useState(false);
  const withoutCd = dialog.tool === "bash" ? withoutSessionCd(body, props.cwd) : null;
  const bodyText = useClipped(withoutCd === null || fullCommand ? body : withoutCd, BODY_LIMITS);
  const causes = dialog.tainted ? dialog.taintCauses : undefined;
  const markable =
    props.sessionId !== undefined &&
    props.sessionId !== "" &&
    causes !== undefined &&
    causes.older === 0 &&
    causes.list.length > 0 &&
    causes.list.every((c) => c.markable);
  // The card splits the header off the first line itself; a message of one line has no header and is all body.
  const category = t(`dialog.category.${dialog.category ?? "unknown"}`);
  const bodyLines = bodyText.shown.split("\n").length;
  const detail = header === null ? bodyText.shown : `${headerText.shown}\n${bodyText.shown}`;
  return (
    <ApprovalCard
      wide={phone}
      title={t("dialog.approval")}
      category={dialog.tainted ? t("sessionPolicy.taintedCategory", { category }) : category}
      question={
        <>
          <p
            data-approval-question
            {...scrollArea(question.expanded, t("dialog.question"))}
            className={cn(
              "max-h-32 overflow-auto whitespace-pre-wrap break-words text-ui font-semibold text-fg",
              FOCUS_RING,
            )}
          >
            {question.shown}
          </p>
          {trigger === null ? null : (
            <p data-approval-trigger className="mt-s1 line-clamp-3 break-words text-ui text-muted">
              {t("inbox.startedBy", { name: visibleName(trigger) })}
            </p>
          )}
          {causes === undefined ? null : <TaintCauseLine causes={causes} />}
          {withoutCd === null ? null : (
            <p data-approval-cd className="mt-s1">
              <Chip tone="mut" label={t("sessionPolicy.cd.badge")} />
            </p>
          )}
          {dialog.guard ? (
            <p data-approval-guard className="mt-s1 text-ui text-muted">
              {t(`sessionPolicy.guard.${dialog.guard}`)}
            </p>
          ) : null}
          {dialog.host === undefined ? null : (
            <p data-approval-host className="mt-s1 break-all font-mono text-ui text-fg">
              {t("dialog.host", { host: dialog.host })}
            </p>
          )}
        </>
      }
      detail={detail}
      withheld={(bodyText.clipped && !bodyText.expanded) || (headerText.clipped && !headerText.expanded)}
      // The command is always on the card: two lines of it, and a button for the rest that says how long it is. Once
      // the owner asked for the clipped rest ("Show more"), the whole box is shown.
      collapse={
        bodyText.expanded
          ? undefined
          : {
              show: bodyLines > 2 ? t("dialog.showAllLines", { count: bodyLines }) : t("dialog.showAll"),
              hide: t("dialog.collapse"),
              blocked: t("dialog.showToAllow"),
            }
      }
      controls={
        question.clipped ||
        headerText.clipped ||
        bodyText.clipped ||
        scopes.length > 0 ||
        markable ||
        withoutCd !== null ? (
          <>
            <ExpandToggle {...question} />
            <ExpandToggle {...headerText} />
            <ExpandToggle {...bodyText} />
            {withoutCd === null ? null : (
              <Button size="sm" aria-expanded={fullCommand} onClick={() => setFullCommand((full) => !full)}>
                {t(fullCommand ? "sessionPolicy.cd.hideFull" : "sessionPolicy.cd.showFull")}
              </Button>
            )}
            {markable && props.sessionId !== undefined ? (
              <MarkLocal sessionId={props.sessionId} causes={causes?.list ?? []} />
            ) : null}
            {scopes.length > 0 ? (
              <AlwaysScopeChoice dialog={dialog} scopes={scopes} value={scope} onChange={setScope} />
            ) : null}
          </>
        ) : undefined
      }
      // The daemon refuses an approval without answers; the owner still gets a way to refuse if one arrives.
      answers={uiAnswers(dialog.answers)}
      labels={{
        deny: t("dialog.answer.deny"),
        session: t("dialog.answer.session"),
        always: t("dialog.answer.always"),
        host: t("dialog.answer.host"),
        once: t("dialog.answer.once"),
      }}
      note={dialog.timeout === undefined ? undefined : timeoutLine(dialog.timeout, t)}
      onChoose={(answer) =>
        props.onAnswer(answer === "always" && scope !== "exact" ? { answer, scope } : { answer })
      }
    />
  );
}

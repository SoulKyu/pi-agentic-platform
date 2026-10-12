import type { Dialog, DialogResponse } from "@pap/contracts";
import { ApprovalCard, cn, FOCUS_RING } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { splitApproval } from "../approval-detail.ts";
import { timeoutLine } from "./ExtensionCard.tsx";
import { plain } from "./untrusted.ts";
import { ExpandToggle, useClipped } from "./use-clipped.tsx";

const BODY_LIMITS = { lines: 200, chars: 4000 } as const;
const HEADER_LIMITS = { lines: 2, chars: 400 } as const;
const QUESTION_LIMITS = { lines: 3, chars: 300 } as const;

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
  onAnswer(response: DialogResponse): void;
}) {
  const { dialog } = props;
  const t = useT();
  const question = useClipped(dialog.title, QUESTION_LIMITS);
  const { header, body } = splitApproval(plain(dialog.message ?? ""));
  const headerText = useClipped(header ?? "", HEADER_LIMITS);
  const bodyText = useClipped(body, BODY_LIMITS);
  // The card splits the header off the first line itself; a message of one line has no header and is all body.
  const detail = header === null ? bodyText.shown : `${headerText.shown}\n${bodyText.shown}`;
  return (
    <ApprovalCard
      title={t("dialog.approval")}
      category={t(`dialog.category.${dialog.category ?? "unknown"}`)}
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
          <ExpandToggle {...question} />
        </>
      }
      detail={detail}
      headerLabel={headerText.expanded ? t("dialog.summary") : undefined}
      context={
        headerText.clipped || bodyText.clipped ? (
          <>
            <ExpandToggle {...headerText} />
            <ExpandToggle {...bodyText} />
          </>
        ) : undefined
      }
      // The daemon refuses an approval without answers; the owner still gets a way to refuse if one arrives.
      answers={dialog.answers?.length ? dialog.answers : ["deny"]}
      labels={{
        deny: t("dialog.answer.deny"),
        session: t("dialog.answer.session"),
        always: t("dialog.answer.always"),
        once: t("dialog.answer.once"),
      }}
      note={dialog.timeout === undefined ? undefined : timeoutLine(dialog.timeout, t)}
      onChoose={(answer) => props.onAnswer({ answer })}
    />
  );
}

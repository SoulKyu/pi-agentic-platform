import type { Dialog, DialogResponse } from "@pap/contracts";
import { t } from "../../../i18n/index.ts";
import { timeoutLine } from "./ExtensionCard.tsx";
import { ApprovalDialog } from "./ApprovalDialog.tsx";

/** Maps the policy's dialog onto the approval card; the card itself knows nothing of dialogs (M2R128). */
export function ApprovalCardFor(props: {
  readonly dialog: Dialog;
  onAnswer(response: DialogResponse): void;
}) {
  const { dialog } = props;
  return (
    <ApprovalDialog
      title={t("dialog.approval", { category: t(`dialog.category.${dialog.category ?? "unknown"}`) })}
      question={dialog.title}
      detail={dialog.message}
      // The daemon refuses an approval without answers; the owner still gets a way to refuse if one arrives.
      answers={dialog.answers?.length ? dialog.answers : ["deny"]}
      timeoutNote={dialog.timeout === undefined ? undefined : timeoutLine(dialog.timeout)}
      labels={{
        deny: t("dialog.answer.deny"),
        session: t("dialog.answer.session"),
        always: t("dialog.answer.always"),
        once: t("dialog.answer.once"),
      }}
      onChoose={(answer) => props.onAnswer({ answer })}
    />
  );
}

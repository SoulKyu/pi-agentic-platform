import type { Dialog, DialogResponse } from "@pap/contracts";
import { t } from "../../../i18n/index.ts";
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
      answers={dialog.answers ?? []}
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

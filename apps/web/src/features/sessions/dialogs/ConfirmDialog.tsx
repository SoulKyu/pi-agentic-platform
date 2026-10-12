import type { Dialog, DialogResponse } from "@pap/contracts";
import { InputRequestCard } from "@pap/ui/extensions";
import { useT } from "../../../i18n/index.ts";
import { useRequestFrame } from "./request-frame.tsx";
import { useAnswer } from "./use-answer.ts";

/** An extension's own yes/no question. The policy's approvals have their own card: this one never says "Approval". */
export function ConfirmDialog(props: { readonly dialog: Dialog; onAnswer(response: DialogResponse): void }) {
  const t = useT();
  const { answered, answer } = useAnswer(props.onAnswer);
  const frame = useRequestFrame(props.dialog, false);
  return (
    <InputRequestCard
      {...frame}
      kind="confirm"
      answered={answered}
      yesLabel={t("dialog.yes")}
      noLabel={t("dialog.no")}
      onConfirm={(confirmed) => answer({ confirmed })}
    />
  );
}

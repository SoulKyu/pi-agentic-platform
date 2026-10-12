import type { Dialog, DialogResponse } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { ExtensionCard } from "./ExtensionCard.tsx";
import { useAnswer } from "./use-answer.ts";

/** An extension's own yes/no question. The policy's approvals have their own card: this one never says "Approval". */
export function ConfirmDialog(props: { readonly dialog: Dialog; onAnswer(response: DialogResponse): void }) {
  const t = useT();
  const { answered, answer } = useAnswer(props.onAnswer);
  return (
    <ExtensionCard dialog={props.dialog}>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={answered} onClick={() => answer({ confirmed: true })}>
          {t("dialog.yes")}
        </Button>
        <Button disabled={answered} onClick={() => answer({ confirmed: false })}>
          {t("dialog.no")}
        </Button>
      </div>
    </ExtensionCard>
  );
}

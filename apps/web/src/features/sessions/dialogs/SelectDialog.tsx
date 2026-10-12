import type { Dialog, DialogResponse } from "@pap/contracts";
import { Button } from "@pap/ui";
import { t } from "../../../i18n/index.ts";
import { ExtensionCard, titleText } from "./ExtensionCard.tsx";
import { useAnswer } from "./use-answer.ts";

/** One button per option, then Cancel. An option label is clipped; it is a label, not a message. */
export function SelectDialog(props: { readonly dialog: Dialog; onAnswer(response: DialogResponse): void }) {
  const { answered, answer } = useAnswer(props.onAnswer);
  return (
    <ExtensionCard dialog={props.dialog}>
      <div className="flex flex-wrap gap-2">
        {(props.dialog.options ?? []).map((option, index) => (
          // The same label may be offered twice: the position tells the buttons apart.
          <Button key={index} disabled={answered} onClick={() => answer({ value: option })}>
            {titleText(option)}
          </Button>
        ))}
        <Button disabled={answered} onClick={() => answer({ cancelled: true })}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </ExtensionCard>
  );
}

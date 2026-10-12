import type { Dialog, DialogResponse } from "@pap/contracts";
import { InputRequestCard } from "@pap/ui/extensions";
import { useT } from "../../../i18n/index.ts";
import { titleText, useRequestFrame } from "./request-frame.tsx";
import { useAnswer } from "./use-answer.ts";

/** One button per option, then Cancel. An option label is clipped; it is a label, not a message. */
export function SelectDialog(props: { readonly dialog: Dialog; onAnswer(response: DialogResponse): void }) {
  const t = useT();
  const { answered, answer } = useAnswer(props.onAnswer);
  const frame = useRequestFrame(props.dialog, false);
  const options = props.dialog.options ?? [];
  return (
    <InputRequestCard
      {...frame}
      kind="select"
      answered={answered}
      options={options.map(titleText)}
      cancelLabel={t("dialog.cancel")}
      onSelect={(index) => {
        // Fail closed: a position the card never offered answers nothing.
        const option = options[index];
        if (option !== undefined) answer({ value: option });
      }}
      onCancel={() => answer({ cancelled: true })}
    />
  );
}

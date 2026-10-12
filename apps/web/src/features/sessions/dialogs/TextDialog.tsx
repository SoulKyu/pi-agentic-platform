import type { Dialog, DialogResponse } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { t } from "../../../i18n/index.ts";
import { ExtensionCard, titleText } from "./ExtensionCard.tsx";
import { clip, plain } from "./untrusted.ts";
import { useAnswer } from "./use-answer.ts";

const PLACEHOLDER_LIMITS = { lines: 1, chars: 200 } as const;

/**
 * `input` is one line (Enter submits) and `editor` is many (Enter types, Ctrl or Cmd+Enter submits). The text typed
 * is given back as `initial` when an answer is refused and the card is built again.
 */
export function TextDialog(props: {
  readonly dialog: Dialog;
  /** What the field holds at first: the dialog's prefill, or what was typed before an answer was refused. */
  readonly initial?: string | undefined;
  onAnswer(response: DialogResponse): void;
}) {
  const { dialog } = props;
  const editor = dialog.method === "editor";
  const { answered, answer } = useAnswer(props.onAnswer);
  const [value, setValue] = useState(() => plain(props.initial ?? dialog.prefill ?? ""));
  const submit = () => answer({ value });
  return (
    <ExtensionCard dialog={dialog} titleInField>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // A single-line field submits on Enter; the Enter that confirms an input-method composition does not.
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            if (!answered) submit();
          }
        }}
      >
        <TextField
          label={titleText(dialog.title)}
          value={value}
          onChange={setValue}
          multiline={editor}
          disabled={answered}
          placeholder={clip(plain(dialog.placeholder ?? ""), PLACEHOLDER_LIMITS).shown || undefined}
          onSubmitShortcut={submit}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={answered} onClick={submit}>
            {t("dialog.submit")}
          </Button>
          <Button disabled={answered} onClick={() => answer({ cancelled: true })}>
            {t("dialog.cancel")}
          </Button>
        </div>
      </form>
    </ExtensionCard>
  );
}

import type { Dialog, DialogResponse } from "@pap/contracts";
import { InputRequestCard } from "@pap/ui/extensions";
import { useT } from "../../../i18n/index.ts";
import { useRequestFrame } from "./request-frame.tsx";
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
  const t = useT();
  const { dialog } = props;
  const { answered, answer } = useAnswer(props.onAnswer);
  const frame = useRequestFrame(dialog, true);
  return (
    <InputRequestCard
      {...frame}
      kind="text"
      answered={answered}
      multiline={dialog.method === "editor"}
      initialValue={plain(props.initial ?? dialog.prefill ?? "")}
      placeholder={clip(plain(dialog.placeholder ?? ""), PLACEHOLDER_LIMITS).shown || undefined}
      submitLabel={t("dialog.submit")}
      cancelLabel={t("dialog.cancel")}
      onSubmit={(value) => answer({ value })}
      onCancel={() => answer({ cancelled: true })}
    />
  );
}

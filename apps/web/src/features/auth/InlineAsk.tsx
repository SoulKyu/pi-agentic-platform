import { Button } from "@pap/ui";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";

/** A reversible action confirms inline, in the row it concerns, never in a modal (DESIGN). */
export function InlineAsk({
  question,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  readonly question: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  onConfirm(): void;
  onCancel(): void;
  readonly children?: ReactNode;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={question} className="flex flex-col items-start gap-s2">
      <p className="text-ui text-fg">{question}</p>
      {children}
      <div className="flex gap-s2">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          {t("account.cancel")}
        </Button>
      </div>
    </div>
  );
}

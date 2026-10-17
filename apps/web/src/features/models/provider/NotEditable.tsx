import { Button } from "@pap/ui";
import type { ReactNode } from "react";
import { type MessageKey, useT } from "../../../i18n/index.ts";
import type { NotEditableReason } from "./use-provider-form.ts";

const SENTENCE: Record<NotEditableReason, MessageKey> = {
  needs_raw_editor: "settingsProviders.notEditable.needs_raw_editor",
  url_unsupported: "settingsProviders.notEditable.url_unsupported",
  api_unsupported: "settingsProviders.notEditable.api_unsupported",
  builtin: "settingsProviders.notEditable.builtin",
  not_in_file: "settingsProviders.notEditable.not_in_file",
};

/** A provider (or a file) the form does not cover: one sentence by reason, a way to the raw editor, no field (MP-RT-02, MP-RT-18). */
export function NotEditable({
  reason,
  onRawEditor,
  onClose,
  children,
}: {
  readonly reason: NotEditableReason;
  onRawEditor(): void;
  onClose(): void;
  /** What can still be done to the provider here (Remove). */
  readonly children?: ReactNode;
}) {
  const t = useT();
  return (
    <div data-not-editable={reason} className="flex flex-col items-start gap-s2">
      <p role="status" className="text-ui text-fg">
        {t(SENTENCE[reason])}
      </p>
      <div className="flex flex-wrap gap-s2">
        {reason === "not_in_file" ? null : (
          <Button variant="primary" onClick={onRawEditor}>
            {t("settingsProviders.openRaw")}
          </Button>
        )}
        <Button onClick={onClose}>{t("settingsProviders.close")}</Button>
      </div>
      {children}
    </div>
  );
}

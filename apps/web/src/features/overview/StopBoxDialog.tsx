import "../../i18n/register-overview.ts";
import type { OverviewActivity } from "@pap/contracts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { activityLine } from "./overview.vm.ts";

interface Props {
  readonly name: string;
  readonly activities: readonly OverviewActivity[];
  /** The box comes back at the next pap start: say so. */
  readonly alwaysOn: boolean;
  /** Stops the box; a refusal rejects with an Error whose message is the text to show. */
  onConfirm(): Promise<void>;
  onClose(): void;
}

/**
 * Stopping a busy box interrupts what runs in it: say what, and what stays. Nothing here is irreversible (transcripts
 * and files are intact), so the confirm is primary, never danger; Cancel is secondary.
 */
export function StopBoxDialog({ name, activities, alwaysOn, onConfirm, onClose }: Props) {
  const t = useT();
  const locale = useLocale();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const list = activities.map((activity) => activityLine({ ...activity, since: null }, locale, t)).join(", ");
  const confirm = () =>
    void pending.run(async () => {
      setProblem(null);
      try {
        await onConfirm();
        onClose();
      } catch (failure) {
        setProblem(failure instanceof Error ? failure.message : t("error.internal"));
      }
    });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && pending.since === null) onClose();
      }}
      title={t("overview.stopDialog.title", { name })}
      description={t("overview.stopDialog.body", { list })}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button variant="secondary" disabled={pending.since !== null} onClick={onClose}>
            {t("overview.stopDialog.cancel")}
          </Button>
          <Button variant="primary" pendingSince={pending.since} onClick={confirm}>
            {t("overview.stopDialog.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {alwaysOn ? <p className="text-ui text-muted">{t("overview.stopDialog.alwaysOn")}</p> : null}
        {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
      </div>
    </Dialog>
  );
}

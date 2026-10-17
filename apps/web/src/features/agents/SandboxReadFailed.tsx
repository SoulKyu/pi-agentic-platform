import "./register-agent-catalog.ts";
import { Button, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import type { SandboxControl } from "./use-sandbox-status.ts";

/**
 * The New agent dialog when the first sandbox read failed: it says so and offers the same "Check again" as Settings ›
 * Agents. A check that answers makes `readFailed` false and the caller shows the form.
 */
export function SandboxReadFailed({
  sandbox,
  onClose,
}: {
  readonly sandbox: SandboxControl;
  onClose(): void;
}) {
  const t = useT();
  const pending = usePendingAction();
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const recheck = () =>
    void pending.run(async () => {
      setNotice(null);
      const outcome = await sandbox.recheck();
      setNotice(
        outcome === "rate_limited"
          ? "agentsSandbox.rateLimited"
          : outcome === "failed"
            ? "agentsSandbox.recheckFailed"
            : null,
      );
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("agentForm.dialog.title")}
      description={t("agentForm.dialog.description")}
      closeLabel={t("agentForm.dialog.close")}
    >
      <div className="flex flex-col gap-s3">
        <p role="status" className="text-ui text-attn">
          {t("agentsSandbox.readFailed")}
        </p>
        <div className="flex flex-wrap items-center gap-s2">
          <Button
            remote={false}
            pendingSince={pending.since}
            stageLabel={t("agentsSandbox.rechecking")}
            onClick={recheck}
          >
            {t("agentsSandbox.recheck")}
          </Button>
          {notice === null ? null : (
            <span role="status" className="text-ui text-attn">
              {t(notice)}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}

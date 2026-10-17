import "./register-memory-catalog.ts";
import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";

export interface ForgetDialogProps {
  readonly count: number;
  readonly problem: string | null;
  readonly since: number | null;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Forget several memories (M11R150): what the request does and what it does not. pi-mem0 stores a recalled memory in the
 * session files of the sessions that recalled it, so forgetting never reaches those (RT-22).
 */
export function ForgetDialog({ count, problem, since, onConfirm, onCancel }: ForgetDialogProps) {
  const t = useT();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t("memory.forget.title")}
      description={t("memory.forget.body")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onCancel}>{t("memory.forget.cancel")}</Button>
          <Button variant="danger" pendingSince={since} onClick={onConfirm}>
            {count === 1 ? t("memory.forget.one") : t("memory.forget.many", { n: count })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        <p className="text-ui text-muted">{t("memory.forget.body2")}</p>
        {problem !== null ? (
          <p role="alert" className="text-ui text-attn">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

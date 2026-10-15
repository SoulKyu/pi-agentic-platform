import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";

export type TaskDialogKind = "stop" | "tools";

interface TaskDialogProps {
  readonly kind: TaskDialogKind | null;
  onClose(): void;
  onConfirm(kind: TaskDialogKind): void;
}

/** The two questions a card asks: "Stop this run?" (a running task) and "Use my normal tools?" (a finished one). Cancel is never danger. */
export function TaskDialogs({ kind, onClose, onConfirm }: TaskDialogProps) {
  const t = useT();
  const stop = kind === "stop";
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(stop ? "automation.dialog.stopTitle" : "automation.dialog.toolsTitle")}
      description={t(stop ? "automation.dialog.stopBody" : "automation.dialog.toolsBody")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t(stop ? "automation.dialog.keep" : "automation.dialog.notNow")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (kind !== null) onConfirm(kind);
            }}
          >
            {t(stop ? "automation.dialog.stop" : "automation.dialog.confirm")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

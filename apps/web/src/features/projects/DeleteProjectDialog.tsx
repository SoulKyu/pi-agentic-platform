import "../../i18n/register-boxes.ts";
import { Button, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { boxFailure } from "../boxes/box-errors.ts";

export interface DeleteProjectDialogProps {
  readonly project: { readonly id: string; readonly name: string };
  /** Scratch is the owner's one default project: a refused delete says why in its own words. */
  readonly scratch: boolean;
  readonly counts: { readonly sessions: number; readonly triggers: number };
  onClose(): void;
  /** The project is gone: the settings behind this dialog close too. */
  onDeleted(): void;
}

/**
 * Delete a project (irreversible, so the confirm is `danger` and Cancel is not): what goes, how long the disk stays in the
 * trash, then the owner's password (`projects.delete` always asks, like `agents.delete`).
 */
export function DeleteProjectDialog({
  project,
  counts,
  scratch,
  onClose,
  onDeleted,
}: DeleteProjectDialogProps) {
  const t = useT();
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<MessageKey | null>(null);

  const remove = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const done = await stepUp((commandId) =>
          rpc.call("projects.delete", { projectId: project.id }, { commandId }),
        );
        if (done !== null) onDeleted();
      } catch (failure) {
        setProblem(boxFailure(failure, scratch));
      }
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("boxes.delete.title")}
      description={t("boxes.delete.confirm", {
        name: project.name,
        sessions: counts.sessions,
        triggers: counts.triggers,
      })}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("account.cancel")}</Button>
          <Button variant="danger" pendingSince={pending.since} onClick={remove}>
            {t("boxes.delete")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {problem === null ? null : (
          <p role="status" className="text-ui text-err">
            {t(problem)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

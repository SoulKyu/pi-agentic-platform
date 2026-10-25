import type { UserView } from "@pap/contracts";
import { Button } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { useUserAction } from "./use-users.ts";

interface Props {
  readonly user: UserView;
  readonly stepUp: StepUpRunner;
  onClose(): void;
  onDeleted(): void;
}

/** Irreversible, so the confirm is `danger` and Cancel is not; `users.delete` then asks the password again. */
export function DeleteUserDialog({ user, stepUp, onClose, onDeleted }: Props) {
  const t = useT();
  const action = useUserAction();
  const remove = () =>
    action.run(async () => {
      const done = await stepUp((commandId) =>
        getRuntime().rpc.call("users.delete", { userId: user.id }, { commandId }),
      );
      if (done !== null) onDeleted();
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("users.delete.title", { name: user.username })}
      description={t("users.delete.body", { name: user.username })}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("users.cancel")}</Button>
          <Button variant="danger" pendingSince={action.since} onClick={remove}>
            {t("users.delete.confirm", { name: user.username })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {action.problem === null ? null : (
          <p role="status" className="text-ui text-err">
            {t(action.problem)}
          </p>
        )}
      </div>
    </Dialog>
  );
}

import "../../i18n/register-github.ts";
import { Button, InlineError } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { useGithubAction } from "./use-github-action.ts";

interface Props {
  readonly stepUp: StepUpRunner;
  onClose(): void;
  /** The App and every token are gone. */
  onDeleted(): void;
}

/** Delete the App (irreversible, so the confirm is `danger` and Cancel is not): `github.forget` asks the password again. */
export function DeleteAppDialog({ stepUp, onClose, onDeleted }: Props) {
  const t = useT();
  const action = useGithubAction();
  const remove = () =>
    action.run(async () => {
      const { rpc } = getRuntime();
      const done = await stepUp((commandId) => rpc.call("github.forget", {}, { commandId }));
      if (done !== null) onDeleted();
    });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("github.delete.title")}
      description={t("github.delete.body")}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("account.cancel")}</Button>
          <Button variant="danger" pendingSince={action.since} onClick={remove}>
            {t("github.delete")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-s2 p-s3">
        {action.problem === null ? null : <InlineError announce="action">{t(action.problem)}</InlineError>}
      </div>
    </Dialog>
  );
}

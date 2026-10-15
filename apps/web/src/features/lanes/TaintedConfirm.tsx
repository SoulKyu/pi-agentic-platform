import "./register-lanes-catalog.ts";
import { Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

/**
 * One inline confirmation, never a modal (M9R121): the lane's files run, and an agent that read external content may
 * have changed them. Tasks 13 and 22 reuse it for Run setup, Archive and Close losers.
 */
export function TaintedConfirm({
  onConfirm,
  onCancel,
  busy,
}: {
  onConfirm(): void;
  onCancel(): void;
  readonly busy?: boolean;
}) {
  const t = useT();
  return (
    <div role="status" className="flex flex-col gap-s2 border-l-2 border-attn pl-s2">
      <p className="text-ui text-fg">{t("lanes.tainted.body")}</p>
      <div className="flex flex-wrap gap-s2">
        <Button variant="primary" disabled={busy === true} onClick={onConfirm}>
          {t("lanes.tainted.run")}
        </Button>
        <Button disabled={busy === true} onClick={onCancel}>
          {t("lanes.action.cancel")}
        </Button>
      </div>
    </div>
  );
}

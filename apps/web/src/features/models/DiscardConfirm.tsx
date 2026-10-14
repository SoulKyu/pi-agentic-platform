import { Button } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

/** Asks before unsaved `models.json` edits are thrown away (closing the editor, or another provider). */
export function DiscardConfirm({ onDiscard, onKeep }: { onDiscard(): void; onKeep(): void }) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("settingsModels.json.discardAsk")}
      className="flex flex-col items-start gap-s2"
    >
      <p className="text-ui text-fg">{t("settingsModels.json.discardAsk")}</p>
      <div className="flex gap-s2">
        <Button variant="primary" onClick={onDiscard}>
          {t("settingsModels.json.discard")}
        </Button>
        <Button onClick={onKeep}>{t("settingsModels.json.keep")}</Button>
      </div>
    </div>
  );
}

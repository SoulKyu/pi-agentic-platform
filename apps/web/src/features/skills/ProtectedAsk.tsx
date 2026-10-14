import { Button } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "./skills.vm.ts";

/**
 * The inline "Save anyway?" before any write to a project's `.pi/` folder (M7R133): it can run code later. Same words
 * as the MCP ask and M8's protected-save ask; Cancel is never `danger`.
 */
export function ProtectedAsk({
  path,
  disabled,
  onSave,
  onCancel,
}: {
  readonly path: string;
  /** A write is on its way: Save would be dropped, so it waits. */
  readonly disabled: boolean;
  onSave(): void;
  onCancel(): void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // The ask can open far from the clicked control: it takes focus (M1).
  useEffect(() => box.current?.querySelector("button")?.focus(), []);
  const ask = t("settingsSkills.protected.ask", { path: escapeHidden(path) });
  return (
    <div ref={box} role="group" aria-label={ask} className="flex flex-col items-start gap-s2">
      <p className="text-ui text-fg">{ask}</p>
      <div className="flex gap-s2">
        <Button variant="primary" disabled={disabled} onClick={onSave}>
          {t("settingsSkills.protected.save")}
        </Button>
        <Button onClick={onCancel}>{t("settingsSkills.protected.cancel")}</Button>
      </div>
    </div>
  );
}

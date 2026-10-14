import { Button } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "./mcp.vm.ts";

/**
 * The inline "Save anyway?" before any write to a project's `.pi/mcp.json` (M7R133): the file can run commands
 * later. Same words as M8's protected-save ask; Cancel is never `danger`.
 */
export function ProtectedAsk({
  path,
  disabled,
  onSave,
  onCancel,
}: {
  readonly path: string;
  /** A write is on its way: Save would be dropped, so it waits (M6). */
  readonly disabled: boolean;
  onSave(): void;
  onCancel(): void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // The ask can open far from the clicked switch: it takes focus (M1).
  useEffect(() => box.current?.querySelector("button")?.focus(), []);
  return (
    <div
      ref={box}
      role="group"
      aria-label={t("settingsMcp.protected.ask", { path: escapeHidden(path) })}
      className="flex flex-col items-start gap-s2"
    >
      <p className="text-ui text-fg">{t("settingsMcp.protected.ask", { path: escapeHidden(path) })}</p>
      <div className="flex gap-s2">
        <Button variant="primary" disabled={disabled} onClick={onSave}>
          {t("settingsMcp.protected.save")}
        </Button>
        <Button onClick={onCancel}>{t("settingsMcp.protected.cancel")}</Button>
      </div>
    </div>
  );
}

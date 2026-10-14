import { Button } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "./mcp.vm.ts";

export interface UndoOffer {
  readonly token: string;
  readonly scope: "global" | "project";
  readonly name: string;
  readonly expiresInMs: number;
}

/**
 * The Undo of a removal (DESIGN §9.1). ponytail: an inline row, because `Toast` is fixed at 5 s; one offer at a time, a
 * second Remove replaces it (the first server token just expires after its minute). It stays in the panel for the daemon's whole window (60 s), longer than a
 * transient toast, and goes away on its own when the window is over.
 */
export function UndoToast({
  offer,
  disabled,
  onUndo,
  onExpire,
}: {
  readonly offer: UndoOffer;
  readonly disabled: boolean;
  onUndo(): void;
  onExpire(): void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  // The removed row's button is gone: focus lands on Undo (M1).
  useEffect(() => box.current?.querySelector("button")?.focus(), []);
  useEffect(() => {
    const timer = setTimeout(onExpire, offer.expiresInMs);
    return () => clearTimeout(timer);
  }, [offer, onExpire]);
  return (
    <div
      ref={box}
      role="status"
      className="flex flex-wrap items-center gap-s2 rounded-md border border-border-strong bg-surface px-s3 py-s2"
    >
      <p className="min-w-0 flex-1 text-ui text-fg">
        {t("settingsMcp.removed", { name: escapeHidden(offer.name) })}
      </p>
      <Button disabled={disabled} onClick={onUndo}>
        {t("settingsMcp.undo")}
      </Button>
    </div>
  );
}

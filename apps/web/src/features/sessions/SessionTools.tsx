import type { SessionLoadout, ToolPreset } from "@pap/contracts";
import { Button, InlineError } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useState } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { getRuntime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { failureText, outcomeUnknown } from "./failure.ts";
import { crossesChat, PRESET_ORDER } from "./presets.vm.ts";
import "./register-tools-catalog.ts";
import { useAction } from "./use-action.ts";

interface SessionToolsProps {
  readonly sessionId: string;
  /** Null while the session is cold; the stored preset then comes from the session's view (MC37). */
  readonly loadout: SessionLoadout | null;
  readonly running: boolean;
}

/**
 * The tools chip: the session's preset and a menu to change it. A cold session shows the preset the daemon stored
 * (MC37), or this visit's own choice (a cold choice is stored by the daemon, nothing more); "—" only before a snapshot. Switching into or out of
 * Chat restarts a live worker, so it asks first.
 */
export function SessionTools({ sessionId, loadout, running }: SessionToolsProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const runtime = getRuntime();
  const [asking, setAsking] = useState<ToolPreset | null>(null);
  const [chosen, setChosen] = useState<ToolPreset | null>(null);
  // After a timeout the outcome is unknown (R105): a choice of this visit is no longer trusted, only the daemon's word.
  const change = useAction(undefined, undefined, (failure) => {
    if (outcomeUnknown(failure)) setChosen(null);
    return failureText(failure);
  });
  const stored = useSessionStore((state) => state.views[sessionId]?.toolPreset ?? null);
  const live = loadout?.preset ?? null;
  const shown = live ?? chosen ?? stored;
  const nameOf = (preset: ToolPreset | null) =>
    preset ? t(`sessionTools.name.${preset}`) : t("sessionTools.unknown");

  const send = async (preset: ToolPreset) => {
    setAsking(null);
    const saved = await change.run(() =>
      runtime.rpc.call("sessions.setTools", { sessionId, preset }, { commandId: runtime.rpc.newCommandId() }),
    );
    if (saved) setChosen(preset);
  };
  const pick = (preset: ToolPreset) => {
    change.clear();
    if (crossesChat(live, preset)) setAsking(preset);
    else void send(preset);
  };
  const items: MenuItem[] = PRESET_ORDER.map((preset) => ({
    id: preset,
    label: t(preset === shown ? "sessionTools.itemCurrent" : "sessionTools.item", {
      name: nameOf(preset),
      about: t(`sessionTools.about.${preset}`),
    }),
    onSelect: () => pick(preset),
  }));

  return (
    <div data-session-tools className="flex flex-col gap-s1">
      <LazyMenu
        label={t("sessionTools.menu")}
        closeLabel={t("sessionTools.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => (
          <Button variant="pill" size="sm" disabled={running || change.busy} onClick={ask}>
            {t("sessionTools.pill", { preset: nameOf(shown) })}
          </Button>
        )}
      />
      {shown === "read-only" ? <p className="text-ui text-muted">{t("sessionTools.readOnlyNote")}</p> : null}
      {asking ? (
        <div
          role="group"
          aria-label={t("sessionTools.restart")}
          data-inline-edit
          className="flex flex-col items-start gap-s2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setAsking(null);
          }}
        >
          <p className="text-ui text-fg">{t("sessionTools.restart")}</p>
          <div className="flex gap-s2">
            <Button variant="primary" disabled={change.busy} onClick={() => void send(asking)}>
              {t("sessionTools.switch", { name: nameOf(asking) })}
            </Button>
            <Button onClick={() => setAsking(null)}>{t("sessionTools.cancel")}</Button>
          </div>
        </div>
      ) : null}
      {change.error ? <InlineError announce="action">{change.error}</InlineError> : null}
    </div>
  );
}

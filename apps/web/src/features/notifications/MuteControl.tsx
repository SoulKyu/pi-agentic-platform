import { Segmented } from "@pap/ui";
import { useLocale, useT } from "../../i18n/index.ts";
import { MUTE_FOREVER, mutePreset, type MutePreset } from "./notifications.vm.ts";

/** Off / 1 h / 8 h / until the owner lifts it. The stored value is `muteUntil`, computed from the clock at the click. */
export function MuteControl({
  muteUntil,
  now,
  disabled,
  onPick,
}: {
  readonly muteUntil: number | null;
  readonly now: number;
  readonly disabled: boolean;
  onPick(preset: MutePreset): void;
}) {
  const t = useT();
  const locale = useLocale();
  const preset = mutePreset(muteUntil, now);
  return (
    <div data-slot="notifications-mute" className="flex flex-col gap-s1">
      <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
        <Segmented
          label={t("notifications.mute.label")}
          value={preset as MutePreset}
          options={[
            { value: "off", label: t("notifications.mute.off") },
            { value: "1h", label: t("notifications.mute.1h") },
            { value: "8h", label: t("notifications.mute.8h") },
            { value: "forever", label: t("notifications.mute.forever") },
          ]}
          onChange={(next) => {
            if (!disabled) onPick(next);
          }}
        />
      </fieldset>
      {preset === "forever" ? (
        <p className="text-ui text-muted">{t("notifications.mute.foreverNote")}</p>
      ) : preset === "off" || muteUntil === null || muteUntil >= MUTE_FOREVER ? null : (
        <p className="text-ui text-muted">
          {t("notifications.mute.until", {
            time: new Date(muteUntil).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
          })}
        </p>
      )}
    </div>
  );
}

import { Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { PricingSetting } from "./use-pricing-setting.ts";

/** The models.dev opt-in (M7R138): off until the owner switches it on; nothing is sent to models.dev either way. */
export function PricingSwitch({ setting }: { readonly setting: PricingSetting }) {
  const t = useT();
  return (
    <div data-pricing-switch className="flex flex-col gap-s1">
      <Switch
        label={t("settingsModels.pricing.switch")}
        hint={t("settingsModels.pricing.hint")}
        checked={setting.on}
        disabled={!setting.loaded || setting.busy}
        onChange={setting.set}
      />
      {setting.notice ? (
        <p role="status" className="text-ui text-muted">
          {setting.notice}
        </p>
      ) : null}
    </div>
  );
}

import type { ProviderView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import "../../i18n/register-settings-providers.ts";
import { useT } from "../../i18n/index.ts";
import { stripHidden } from "../../lib/untrusted-text.ts";
import { envIsSet, signInState } from "./models.vm.ts";
import type { ProviderFormHost } from "./use-provider-form-host.ts";

/** Providers in a list with their sign-in state chips (M7R68): configured, not configured, or unknown. */
export function ProviderList({
  providers,
  selected,
  onSelect,
  forms,
}: {
  readonly providers: readonly ProviderView[];
  readonly selected: string | null;
  onSelect(id: string): void;
  readonly forms: ProviderFormHost;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-s2">
      <div className="flex flex-col items-start gap-s1">
        <Button disabled={forms.commented} onClick={forms.openAdd}>
          {t("settingsProviders.add")}
        </Button>
        {forms.commented ? (
          <p role="status" className="text-ui text-muted">
            {t("settingsProviders.notEditable.needs_raw_editor")}
          </p>
        ) : null}
      </div>
      <ul aria-label={t("settingsModels.list.label")} className="flex flex-col gap-s1">
        {providers.map((provider) => {
          const state = signInState(provider);
          return (
            <li key={provider.id} className="flex items-center gap-s1">
              <Button
                variant="ghost"
                data-provider={provider.id}
                aria-current={provider.id === selected ? "true" : undefined}
                onClick={() => onSelect(provider.id)}
              >
                <span className="flex-1 text-left">{stripHidden(provider.name)}</span>
                {state === "configured" ? (
                  <Chip tone="ok" label={t("settingsModels.chip.configured")} />
                ) : null}
                {state === "notConfigured" ? (
                  <Chip tone="mut" label={t("settingsModels.chip.notConfigured")} />
                ) : null}
                {state === "unknown" ? <Chip tone="att" label={t("settingsModels.chip.unknown")} /> : null}
                {envIsSet(provider) ? <Chip tone="ok" label={t("settingsModels.chip.env")} /> : null}
              </Button>
              {provider.origin === "models.json" ? (
                <Button
                  data-edit-provider={provider.id}
                  aria-label={t("settingsProviders.edit.aria", { name: stripHidden(provider.name) })}
                  onClick={() => forms.openEdit(provider.id)}
                >
                  {t("settingsProviders.edit")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

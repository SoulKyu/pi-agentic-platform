import type { ProviderView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { envIsSet, signInState } from "./models.vm.ts";

/** Providers in a list with their sign-in state chips (M7R68): configured, not configured, or unknown. */
export function ProviderList({
  providers,
  selected,
  onSelect,
}: {
  readonly providers: readonly ProviderView[];
  readonly selected: string | null;
  onSelect(id: string): void;
}) {
  const t = useT();
  return (
    <ul aria-label={t("settingsModels.list.label")} className="flex flex-col gap-s1">
      {providers.map((provider) => {
        const state = signInState(provider);
        return (
          <li key={provider.id}>
            <Button
              variant="ghost"
              data-provider={provider.id}
              aria-current={provider.id === selected ? "true" : undefined}
              onClick={() => onSelect(provider.id)}
            >
              <span className="flex-1 text-left">{provider.name}</span>
              {state === "configured" ? <Chip tone="ok" label={t("settingsModels.chip.configured")} /> : null}
              {state === "notConfigured" ? (
                <Chip tone="mut" label={t("settingsModels.chip.notConfigured")} />
              ) : null}
              {state === "unknown" ? <Chip tone="att" label={t("settingsModels.chip.unknown")} /> : null}
              {envIsSet(provider) ? <Chip tone="ok" label={t("settingsModels.chip.env")} /> : null}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

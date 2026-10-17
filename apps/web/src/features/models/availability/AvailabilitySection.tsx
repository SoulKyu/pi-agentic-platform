import type { ModelsOverview } from "@pap/contracts";
import { Button, useIsPhone } from "@pap/ui";
import { useMemo, useState } from "react";
import "../../../i18n/register-settings-availability.ts";
import { useT } from "../../../i18n/index.ts";
import { modeOf, providerRows, unmatchedWarnings, type AvailabilityMode } from "./availability.vm.ts";
import { ExtensionProviders } from "./ExtensionProviders.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import { Preview } from "./Preview.tsx";
import { ProviderRows } from "./ProviderRows.tsx";
import { useAvailability } from "./use-availability.ts";

/**
 * Settings > Models > Available models (MPR16, owner q3): the mode first, then the provider rows with their switches,
 * then the preview of what a picker offers. Writes go through `models.setEnabled` and the preview is read again after
 * each one. The overview and its reload come from the Settings screen, so the provider list below stays in step.
 */
export function AvailabilitySection({
  overview,
  reloadOverview,
}: {
  readonly overview: ModelsOverview;
  reloadOverview(): void;
}) {
  const t = useT();
  const phone = useIsPhone();
  const source = useMemo(() => ({ value: overview, reload: reloadOverview }), [overview, reloadOverview]);
  const view = useAvailability(source);
  // "My selection" chosen while there is no list yet: the screen's mode only, until the first switch writes one.
  const [chosen, setChosen] = useState(false);
  const shown: AvailabilityMode = chosen ? "selection" : modeOf(overview.enabled.patterns);
  const readOnly = view.readOnlyPath !== null;
  const rows = useMemo(() => providerRows(overview.providers, view.available), [overview, view.available]);
  const unmatched = unmatchedWarnings(overview.enabled.warnings);
  const handlers = {
    onProvider: (provider: string, enabled: boolean) =>
      void view.write({ op: "provider", provider, enabled }),
    onModel: (provider: string, modelId: string, enabled: boolean) =>
      void view.write({ op: "toggle", provider, modelId, enabled }),
  };
  return (
    <section data-availability data-layout={phone ? "stack" : "wide"} className="flex flex-col gap-s4">
      <div className="flex flex-col gap-s1">
        <h2 className="label-hud text-muted">{t("settingsAvailability.title")}</h2>
        <p className="text-ui text-muted">{t("settingsAvailability.intro")}</p>
      </div>
      {readOnly ? (
        <p className="text-ui text-muted">
          {t("settingsAvailability.readOnly", { path: view.readOnlyPath ?? "" })}
        </p>
      ) : (
        <ModeSwitch
          shown={shown}
          patterns={overview.enabled.patterns}
          busy={view.pending.has("clear")}
          onSelection={() => setChosen(true)}
          onAll={() => setChosen(false)}
          onClear={() => {
            setChosen(false);
            void view.write({ op: "clear" });
          }}
        />
      )}
      {shown === "all" && !readOnly ? (
        <p className="text-ui text-muted">{t("settingsAvailability.mode.allNote")}</p>
      ) : null}
      {view.notice ? (
        <p
          role={view.notice.tone === "error" ? "alert" : "status"}
          className={view.notice.tone === "error" ? "text-ui text-attn" : "text-ui text-muted"}
        >
          {view.notice.text}
        </p>
      ) : null}
      {unmatched.length > 0 ? (
        <div className="flex flex-col items-start gap-s2">
          <p className="text-ui text-fg">{t("settingsAvailability.unmatched.title")}</p>
          <ul className="flex flex-col gap-s1 text-ui text-muted">
            {unmatched.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
          <Button
            disabled={readOnly || view.pending.has("prune")}
            onClick={() => void view.write({ op: "prune" })}
          >
            {t("settingsAvailability.unmatched.clean")}
          </Button>
        </div>
      ) : null}
      <ProviderRows
        rows={rows}
        disabled={readOnly || shown === "all"}
        pending={view.pending}
        stack={phone}
        handlers={handlers}
      />
      <Preview available={view.available} />
      <ExtensionProviders providers={overview.providers} providersTruncated={overview.truncated} />
    </section>
  );
}

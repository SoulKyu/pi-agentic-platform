import { Button, Heading, InlineError, LoadingLine } from "@pap/ui";
import "../../../i18n/register-launch.ts";
import { usePiCauseText } from "../../../stores/loading-cause.ts";
import { useState } from "react";
import { plural, useLocale, useT } from "../../../i18n/index.ts";
import type { AvailableState } from "../picker/use-available-models.ts";
import { previewGroups } from "./availability.vm.ts";

/** Groups drawn before "show more": the preview stays short on a screen with many providers. */
const GROUPS_SHOWN = 5;
/** Names a group lists before it counts the rest. */
const NAMES_SHOWN = 20;

/**
 * "What your pickers offer": the list `models.available` returned, count and origin first, then the models grouped by
 * provider. It reads the answer only, never the switches, so it is the list a picker would show (MPR1).
 */
export function Preview({ available }: { readonly available: AvailableState }) {
  const t = useT();
  const cause = usePiCauseText(t);
  const locale = useLocale();
  const [all, setAll] = useState(false);
  const groups = previewGroups(available);
  const shown = all ? groups : groups.slice(0, GROUPS_SHOWN);
  return (
    <section data-preview className="flex flex-col gap-s2">
      <Heading level={3} variant="group">
        {t("settingsAvailability.preview.title")}
      </Heading>
      {available.status === "loading" ? (
        <LoadingLine label={t("settingsAvailability.preview.loading")} cause={cause} />
      ) : null}
      {available.status === "failed" ? (
        <div className="flex flex-col items-start gap-s2">
          <InlineError announce="background">
            {available.stale
              ? t("settingsAvailability.reload")
              : (available.message ?? t("settingsAvailability.preview.failed"))}
          </InlineError>
          <Button onClick={available.reload}>{t("settingsAvailability.preview.retry")}</Button>
        </div>
      ) : null}
      {available.status === "ready" ? (
        <>
          <p role="status" className="text-ui text-fg">
            {plural(locale, "settingsAvailability.preview.count", available.models.length)}
            {" · "}
            {t(
              available.origin === "scope"
                ? "settingsAvailability.preview.origin.scope"
                : "settingsAvailability.preview.origin.signed-in",
            )}
          </p>
          {available.models.length === 0 ? (
            <p className="text-ui text-muted">{t("settingsAvailability.preview.empty")}</p>
          ) : null}
          {shown.map((group, at) => (
            <div
              key={`${at}:${group.provider}`}
              data-preview-group={group.provider}
              className="flex flex-col gap-s1"
            >
              <h4 className="text-ui text-fg">{group.label}</h4>
              <ul className="flex flex-col gap-s1 pl-s4 text-ui text-muted">
                {group.rows.slice(0, NAMES_SHOWN).map((model, row) => (
                  <li key={`${row}:${model.id}`} data-preview-model={model.id}>
                    {model.name === "" ? model.id : model.name}
                  </li>
                ))}
                {group.rows.length > NAMES_SHOWN ? (
                  <li>
                    {t("settingsAvailability.preview.rows.more", { count: group.rows.length - NAMES_SHOWN })}
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
          {groups.length > GROUPS_SHOWN ? (
            <div>
              <Button onClick={() => setAll(!all)}>
                {all
                  ? t("settingsAvailability.preview.groups.less")
                  : t("settingsAvailability.preview.groups.more", { count: groups.length - GROUPS_SHOWN })}
              </Button>
            </div>
          ) : null}
          {available.truncated ? (
            <p className="text-ui text-muted">{t("settingsAvailability.preview.truncated")}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

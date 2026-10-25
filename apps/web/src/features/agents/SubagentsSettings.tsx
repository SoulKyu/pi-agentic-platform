import "../../i18n/register-subagents.ts";
import { Heading, InlineError, Segmented, Switch, LoadingLine } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { usePiCauseText } from "../../stores/loading-cause.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { useSubagentProfiles } from "./use-subagent-profiles.ts";
import { useSubagentsSetting } from "./use-subagents-setting.ts";

const DESCRIPTION_UNITS = 300;
const LIMITS = ["1", "2", "3", "4"] as const;

/**
 * Settings › Agents › Subagents (M11R155): the switch (default on), how many run at once per session (1 to 4, default 2)
 * and the profiles, read-only. A profile is a Pi agent file: it is edited there, never here.
 */
export function SubagentsSettings() {
  const t = useT();
  const cause = usePiCauseText(t);
  const setting = useSubagentsSetting();
  const profiles = useSubagentProfiles();
  const options = LIMITS.map((value) => ({ value, label: value }));
  return (
    <section aria-labelledby="subagents-settings-title" className="flex flex-col gap-s3">
      <Heading level={2} variant="group" id="subagents-settings-title">
        {t("subagents.settings.title")}
      </Heading>
      <p className="text-ui text-muted">{t("subagents.settings.intro")}</p>
      {setting.failed ? (
        <InlineError announce="background">{t("subagents.settings.loadFailed")}</InlineError>
      ) : setting.value === null ? (
        <LoadingLine label={t("subagents.settings.loading")} />
      ) : (
        <>
          <Switch
            label={t("subagents.settings.enabled")}
            hint={t("subagents.settings.enabled.hint")}
            checked={setting.value.enabled}
            disabled={setting.busy}
            onChange={(enabled) => setting.change({ enabled })}
          />
          <div className="flex flex-col gap-s1">
            <Segmented
              label={t("subagents.settings.max")}
              value={String(setting.value.maxConcurrent) as (typeof LIMITS)[number]}
              options={options}
              onChange={(next) => setting.change({ maxConcurrent: Number(next) })}
            />
            <span className="text-ui text-muted">{t("subagents.settings.max.hint")}</span>
          </div>
        </>
      )}
      {setting.notice ? <InlineError announce="action">{setting.notice}</InlineError> : null}
      <Heading level={3} variant="group">
        {t("subagents.profiles.title")}
      </Heading>
      <p className="text-ui text-muted">{t("subagents.profiles.hint")}</p>
      {profiles.kind === "loading" ? (
        <LoadingLine label={t("subagents.profiles.loading")} cause={cause} />
      ) : profiles.kind === "needSession" ? (
        <p className="text-ui text-muted">{t("subagents.profiles.needSession")}</p>
      ) : profiles.kind === "failed" ? (
        <InlineError announce="background">{t("subagents.profiles.failed")}</InlineError>
      ) : profiles.profiles.length === 0 ? (
        <p className="text-ui text-muted">{t("subagents.profiles.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-s2">
          {profiles.profiles.map((profile) => (
            <li
              key={`${profile.source}:${profile.name}`}
              data-profile
              className="flex flex-col gap-s1 border-l-2 border-border px-s3"
            >
              <div className="flex items-baseline gap-s2">
                <span data-profile-name className="font-mono text-ui text-fg">
                  {profile.name}
                </span>
                <span className="label-hud text-muted">
                  {t(`subagents.profiles.source.${profile.source}`)}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-ui text-muted">
                {cutUnits(stripHidden(profile.description), DESCRIPTION_UNITS)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {profiles.kind === "ready" && profiles.truncated ? (
        <p className="text-ui text-muted">{t("subagents.profiles.truncated")}</p>
      ) : null}
    </section>
  );
}

import "../../i18n/register-subagents.ts";
import { Segmented, Switch } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
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
  const setting = useSubagentsSetting();
  const profiles = useSubagentProfiles();
  const options = LIMITS.map((value) => ({ value, label: value }));
  return (
    <section aria-labelledby="subagents-settings-title" className="flex flex-col gap-s3">
      <h2 id="subagents-settings-title" className="label-hud text-muted">
        {t("subagents.settings.title")}
      </h2>
      <p className="text-ui text-muted">{t("subagents.settings.intro")}</p>
      {setting.failed ? (
        <p role="alert" className="text-ui text-attn">
          {t("subagents.settings.loadFailed")}
        </p>
      ) : setting.value === null ? (
        <p role="status" className="text-ui text-muted">
          {t("subagents.settings.loading")}
        </p>
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
      {setting.notice ? (
        <p role="alert" className="text-ui text-attn">
          {setting.notice}
        </p>
      ) : null}
      <h3 className="label-hud text-muted">{t("subagents.profiles.title")}</h3>
      <p className="text-ui text-muted">{t("subagents.profiles.hint")}</p>
      {profiles.kind === "loading" ? (
        <p role="status" className="text-ui text-muted">
          {t("subagents.profiles.loading")}
        </p>
      ) : profiles.kind === "needSession" ? (
        <p className="text-ui text-muted">{t("subagents.profiles.needSession")}</p>
      ) : profiles.kind === "failed" ? (
        <p role="alert" className="text-ui text-attn">
          {t("subagents.profiles.failed")}
        </p>
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

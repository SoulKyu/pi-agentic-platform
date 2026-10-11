import "./register-settings-catalog.ts";
import { Select, useIsPhone } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { pathOfItem, SETTINGS_SECTIONS, type SettingsSection } from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { SETTINGS_SECTION_RENDERERS } from "./sections.tsx";

const LINK_CLASSES = "flex h-control items-center rounded-sm border-l-2 px-s2 text-ui focus-ring";

/** Personal sections on the left (a Section select on phones), the chosen section on the right. */
export function SettingsScreen({ section }: { readonly section: SettingsSection }) {
  const t = useT();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const options = SETTINGS_SECTIONS.map((value) => ({ value, label: t(`settings.section.${value}`) }));
  const heading = `settings-${section}`;
  return (
    <div data-settings-screen className={phone ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1"}>
      {phone ? (
        <div className="shrink-0 border-b border-border bg-bg-side p-s2">
          <Select
            label={t("settings.nav.section")}
            value={section}
            options={options}
            onChange={(next) =>
              navigate({ to: pathOfItem({ kind: "settings", section: next }) }).catch(() =>
                reportClientIssue("command_failed"),
              )
            }
          />
        </div>
      ) : (
        <nav
          aria-label={t("settings.nav.label")}
          className="w-56 shrink-0 border-r border-border bg-bg-side p-s2"
        >
          <p className="label-hud px-s2 pb-s1 text-muted">{t("settings.nav.personal")}</p>
          {options.map((option) => (
            <Link
              key={option.value}
              to={pathOfItem({ kind: "settings", section: option.value })}
              aria-current={option.value === section ? "page" : undefined}
              className={`${LINK_CLASSES} ${option.value === section ? "border-agent bg-surface-2 text-fg" : "border-transparent text-muted can-hover:hover:text-fg"}`}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      )}
      <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-s4 overflow-y-auto p-s4">
        <h1 id={heading} className="text-h1 text-fg">
          {t(`settings.section.${section}`)}
        </h1>
        {SETTINGS_SECTION_RENDERERS[section]()}
      </section>
    </div>
  );
}

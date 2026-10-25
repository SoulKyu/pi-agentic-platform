import "./register-settings-catalog.ts";
import { Select, useIsPhone } from "@pap/ui";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  pathOfItem,
  sectionFor,
  SETTINGS_GROUPS,
  SETTINGS_LAYOUT,
  sectionsFor,
  type SettingsSection,
} from "../../features/workspace/index.ts";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useRole } from "../../lib/role-context.ts";
import { SETTINGS_SECTION_RENDERERS } from "./sections.tsx";
import { SettingsToolbarSlot } from "../../lib/SettingsToolbar.tsx";

const LINK_CLASSES = "flex h-control items-center border-l-2 px-s2 text-ui focus-ring";

/** The grouped sections on the left (a Section select on phones), the chosen section on the right. */
export function SettingsScreen({ section: requested }: { readonly section: SettingsSection }) {
  const t = useT();
  const role = useRole();
  const section = sectionFor(role, requested);
  const phone = useIsPhone();
  const navigate = useNavigate();
  const shown = sectionsFor(role);
  const groups = SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    options: group.sections
      .filter((value) => shown.includes(value))
      .map((value) => ({ value, label: t(`settings.section.${value}`) })),
  })).filter((group) => group.options.length > 0);
  const options = groups.flatMap((group) => group.options);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
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
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-labelledby={`settings-group-${group.id}`}
              className="mb-s3 flex flex-col"
            >
              <p id={`settings-group-${group.id}`} className="label-hud px-s2 pb-s1 text-muted">
                {t(`settings.nav.group.${group.id}`)}
              </p>
              {group.options.map((option) => (
                <Link
                  key={option.value}
                  to={pathOfItem({ kind: "settings", section: option.value })}
                  aria-current={option.value === section ? "page" : undefined}
                  className={`${LINK_CLASSES} ${option.value === section ? "border-agent bg-surface-2 text-fg" : "border-transparent text-muted can-hover:hover:text-fg"}`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      )}
      <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-s4 overflow-y-auto p-s4">
        <header className="flex flex-wrap items-center justify-between gap-s2">
          <h1 id={heading} className="text-h1 text-fg">
            {t(`settings.section.${section}`)}
          </h1>
          <div ref={setToolbar} data-slot="settings-toolbar" className="flex items-center gap-s2" />
        </header>
        <SettingsToolbarSlot.Provider value={toolbar}>
          {SETTINGS_LAYOUT[section] === "column" ? (
            <div data-settings-body="column" className="flex max-w-settings flex-col gap-s4">
              {SETTINGS_SECTION_RENDERERS[section]()}
            </div>
          ) : (
            SETTINGS_SECTION_RENDERERS[section]()
          )}
        </SettingsToolbarSlot.Provider>
      </section>
    </div>
  );
}

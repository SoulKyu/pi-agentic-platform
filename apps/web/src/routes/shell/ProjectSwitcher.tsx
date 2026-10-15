import { Button, Icon, IconChevronDown } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useEffect } from "react";
import { plural, useLazyFailureText, useLocale, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { reportClientIssue } from "../../lib/report.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { listedProjects, useCurrentProject, useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";

/**
 * "project ▾" (DESIGN §8), drawn as the bordered mono chip of boards 05 and 09 (`.ws`): the current project of this device, and a menu of every project with an active session, or none yet.
 * The button is eager; the menu comes with the overlay chunk on the first press.
 */
export function ProjectSwitcher() {
  const t = useT();
  const locale = useLocale();
  const lazyText = useLazyFailureText();
  const effective = useEffectiveProject();
  const projects = useShellStore((state) => state.view.projects);
  const moreProjects = useShellStore((state) => state.view.moreProjects);
  const choose = useCurrentProject((state) => state.choose);
  const refused = useCurrentProject((state) => state.storageRefused);
  // The choice holds for this page only; the console line is once per change of state, not per render.
  useEffect(() => {
    if (refused) reportClientIssue("storage_refused");
  }, [refused]);

  const name = effective?.name ?? t("shell.project.all");
  const items: MenuItem[] = [
    { id: "all", label: t("shell.project.all"), onSelect: () => choose(null) },
    ...listedProjects(projects).map((project) => ({
      id: project.id,
      label: project.name,
      onSelect: () => choose(project.id),
    })),
  ];
  if (moreProjects > 0) {
    items.push({
      id: "more",
      label: plural(locale, "shell.project.more", moreProjects),
      disabled: true,
      onSelect: () => {},
    });
  }
  items.push({
    id: "add",
    label: t("shell.project.add"),
    onSelect: () => useAddProjectRequest.getState().ask(),
  });

  return (
    <LazyMenu
      label={t("shell.project.menu")}
      closeLabel={t("ui.close")}
      text={lazyText}
      items={items}
      trigger={(ask) => (
        <Button
          variant="secondary"
          size="sm"
          data-project-chip
          aria-label={t("shell.project.label", { name })}
          onClick={ask}
        >
          <span className="max-w-40 truncate">{name}</span>
          <Icon icon={IconChevronDown} size={14} />
        </Button>
      )}
    />
  );
}

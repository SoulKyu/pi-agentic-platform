import type { ProjectSummary } from "@pap/contracts";
import { Button, Icon, IconChevronDown } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useEffect } from "react";
import { plural, useLazyFailureText, useLocale, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { reportClientIssue } from "../../lib/report.ts";
import { useCurrentProject, useEffectiveProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";

const inOrder = (a: ProjectSummary, b: ProjectSummary): number =>
  a.position - b.position || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/**
 * "project ▾" (DESIGN §8): the current project of this device, and a menu of every project with an active session.
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
    ...[...projects.values()]
      .filter((project) => project.sessions > 0)
      .sort(inOrder)
      .map((project) => ({ id: project.id, label: project.name, onSelect: () => choose(project.id) })),
  ];
  if (moreProjects > 0) {
    items.push({
      id: "more",
      label: plural(locale, "shell.project.more", moreProjects),
      disabled: true,
      onSelect: () => {},
    });
  }

  return (
    <LazyMenu
      label={t("shell.project.menu")}
      closeLabel={t("ui.close")}
      text={lazyText}
      items={items}
      trigger={(ask) => (
        <Button variant="ghost" size="sm" aria-label={t("shell.project.label", { name })} onClick={ask}>
          <span className="max-w-40 truncate">{name}</span>
          <Icon icon={IconChevronDown} size={14} />
        </Button>
      )}
    />
  );
}

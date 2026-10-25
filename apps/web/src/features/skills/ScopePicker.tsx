import { Button, Heading } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { defaultScope, escapeHidden, type InstallScope, type ProjectRef } from "./skills.vm.ts";

/** The scope a form is on: the default of the project the owner came from, until they choose; never a project that needs trust. */
export function useInstallScope(project: ProjectRef | null, needsTrust: boolean) {
  const [chosen, setChosen] = useState<InstallScope>(defaultScope(project));
  const scope = needsTrust && chosen === "project" ? "global" : chosen;
  return [scope, setChosen] as const;
}

/** Every install form starts with this choice (M7R118, M7R140): This project (name), or All my projects. */
export function ScopePicker({
  scope,
  project,
  needsTrust,
  onChange,
}: {
  readonly scope: InstallScope;
  readonly project: ProjectRef | null;
  /** The project's resources are not trusted yet: a project install would be refused. */
  readonly needsTrust: boolean;
  onChange(scope: InstallScope): void;
}) {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("settingsSkills.scope.label")}
      className="flex flex-col items-start gap-s1"
    >
      <Heading level={4} variant="group">
        {t("settingsSkills.scope.label")}
      </Heading>
      <div className="flex gap-s2">
        <Button
          variant={scope === "project" ? "primary" : "secondary"}
          aria-pressed={scope === "project"}
          disabled={project === null || needsTrust}
          onClick={() => onChange("project")}
        >
          {project === null
            ? t("settingsSkills.scope.projectBare")
            : t("settingsSkills.scope.project", { name: escapeHidden(project.name) })}
        </Button>
        <Button
          variant={scope === "global" ? "primary" : "secondary"}
          aria-pressed={scope === "global"}
          onClick={() => onChange("global")}
        >
          {t("settingsSkills.scope.global")}
        </Button>
      </div>
      <p className="text-ui text-muted">
        {t(scope === "global" ? "settingsSkills.scope.globalNote" : "settingsSkills.scope.projectNote")}
      </p>
    </div>
  );
}

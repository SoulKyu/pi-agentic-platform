import { Button, TextField, Heading } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { ScopePicker, useInstallScope } from "./ScopePicker.tsx";
import type { InstallScope, ProjectRef } from "./skills.vm.ts";

/** Install a Pi package (M7R118): the scope first, then the source; Pi's package manager does the install. */
export function PluginInstall({
  project,
  needsTrust,
  busy,
  onInstall,
}: {
  readonly project: ProjectRef | null;
  readonly needsTrust: boolean;
  readonly busy: boolean;
  onInstall(source: string, scope: InstallScope): void;
}) {
  const t = useT();
  const [source, setSource] = useState("");
  const [scope, setScope] = useInstallScope(project, needsTrust);
  return (
    <section data-plugin-install className="flex flex-col items-start gap-s2">
      <Heading level={4} variant="group">
        {t("settingsSkills.plugin.install.title")}
      </Heading>
      <ScopePicker scope={scope} project={project} needsTrust={needsTrust} onChange={setScope} />
      <TextField
        label={t("settingsSkills.plugin.install.source")}
        value={source}
        autoComplete="off"
        onChange={setSource}
      />
      <p className="text-ui text-muted">{t("settingsSkills.plugin.install.runs")}</p>
      <Button
        variant="primary"
        disabled={source.trim() === "" || busy}
        onClick={() => onInstall(source.trim(), scope)}
      >
        {t("settingsSkills.plugin.install.submit")}
      </Button>
    </section>
  );
}

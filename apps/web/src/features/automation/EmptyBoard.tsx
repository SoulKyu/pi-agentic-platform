import { Button, EmptyState, Select } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { shown } from "./board.vm.ts";

/** No trigger anywhere (M10R115): the purpose in one sentence and "New trigger" with a project chooser. */
export function EmptyBoard({ onNewTrigger }: { onNewTrigger(projectId: string): void }) {
  const t = useT();
  const projects = useShellStore((state) => state.view.projects);
  const currentId = useCurrentProject((state) => state.projectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = [...projects.values()].sort((a, b) => a.position - b.position);
  const fallback = currentId !== null && projects.has(currentId) ? currentId : (list[0]?.id ?? null);
  const selected = chosen !== null && projects.has(chosen) ? chosen : fallback;

  return (
    <EmptyState
      title={t("automation.empty.title")}
      purpose={t("automation.empty.purpose")}
      action={
        selected === null ? (
          <p className="text-ui text-muted">{t("automation.empty.noProject")}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-s2">
            {list.length > 1 ? (
              <Select
                label={t("automation.empty.project")}
                value={selected}
                options={list.map((project) => ({ value: project.id, label: shown(project.name, "name") }))}
                onChange={setChosen}
              />
            ) : null}
            <Button variant="primary" onClick={() => onNewTrigger(selected)}>
              {t("automation.trigger.new")}
            </Button>
          </div>
        )
      }
    />
  );
}

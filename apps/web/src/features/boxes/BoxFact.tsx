import "../../i18n/register-boxes.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { phaseOf } from "../../stores/box-phase.ts";
import { BoxStart } from "./BoxStart.tsx";
import { PhaseChip } from "./PhaseChip.tsx";
import { packagesChanged, useProjectBox } from "./use-project-box.ts";

interface Props {
  readonly project: ProjectSummary;
  onSettings(projectId: string): void;
}

/**
 * The box line of a box project's page: the BOX label, the phase chip (a stopped box is neutral, never red), START while
 * it is stopped, PACKAGES CHANGED when the yaml waits for a rebuild, then the one note about backups. The phase is a polite
 * live region so a screen reader hears it change.
 */
export function BoxFact({ project, onSettings }: Props) {
  const t = useT();
  const phase = phaseOf(project);
  const { state } = useProjectBox(project.id, phase);
  const changed = state.kind === "ready" && packagesChanged(state.box);
  return (
    <section data-box-fact="" aria-label={t("boxes.label")} className="flex flex-col gap-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <span className="label-hud text-muted">{t("boxes.label")}</span>
        <PhaseChip phase={phase} live />
        {changed ? <Chip tone="att" label={t("boxes.packagesChanged")} /> : null}
        {phase === "running" ? null : <BoxStart projectId={project.id} phase={phase} size="sm" />}
        <Button variant="ghost" size="sm" onClick={() => onSettings(project.id)}>
          {t("boxes.settings")}
        </Button>
      </div>
      <p className="text-ui text-muted">{t("boxes.noBackup")}</p>
    </section>
  );
}

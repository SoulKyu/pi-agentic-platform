import "../../i18n/register-boxes.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { useIsLaunching } from "../../stores/launch-store.ts";
import { phaseOf } from "../../stores/box-phase.ts";
import { LaunchPanel } from "../launch/LaunchPanel.tsx";
import { LaunchStrip } from "../launch/LaunchStrip.tsx";
import { BoxStart } from "./BoxStart.tsx";
import { PhaseChip } from "./PhaseChip.tsx";
import { packagesChanged, useProjectBox } from "./use-project-box.ts";

interface Props {
  readonly project: ProjectSummary;
  onSettings(projectId: string): void;
  /** The screen asked for this launch itself: the steps show without a click, until the person toggles them. */
  readonly opened?: boolean;
}

/**
 * The box line of a box project's page: the BOX label, the phase chip (a stopped box is neutral, never red), START while
 * it is stopped, PACKAGES CHANGED when the yaml waits for a rebuild, then the one note about backups. The phase is a polite
 * live region so a screen reader hears it change.
 */
export function BoxFact({ project, onSettings, opened }: Props) {
  const t = useT();
  const phase = phaseOf(project);
  const { state } = useProjectBox(project.id, phase);
  const box = { kind: "project", id: project.id } as const;
  const launching = useIsLaunching(box);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const steps = toggled ?? opened === true;
  const changed = state.kind === "ready" && packagesChanged(state.box);
  return (
    <section data-box-fact="" aria-label={t("boxes.label")} className="flex flex-col gap-s2">
      <div data-phase-row="" className="flex flex-wrap items-center gap-s2">
        <span className="label-hud text-muted">{t("boxes.label")}</span>
        <PhaseChip phase={phase} live />
        {changed ? <Chip tone="att" label={t("boxes.packagesChanged")} /> : null}
        {phase === "running" ? null : (
          <BoxStart box={{ kind: "project", id: project.id }} phase={phase} size="sm" variant="secondary" />
        )}
        <LaunchStrip box={box} />
        {launching ? (
          <Button variant="ghost" size="sm" aria-expanded={steps} onClick={() => setToggled(!steps)}>
            {t(steps ? "launch.steps.hide" : "launch.steps.show")}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => onSettings(project.id)}>
          {t("boxes.settings")}
        </Button>
      </div>
      {steps && launching ? <LaunchPanel box={box} /> : null}
      <p className="text-ui text-muted">{t("boxes.noBackup")}</p>
    </section>
  );
}

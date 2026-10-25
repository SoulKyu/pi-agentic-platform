import "../../i18n/register-home.ts";
import "../../i18n/register-boxes.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button, usePendingAction, InlineError } from "@pap/ui";
import { useEffect, useId, useRef, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { holdProject } from "../../stores/shell-store.ts";

export interface ProjectPickerProps {
  readonly projects: readonly ProjectSummary[];
  onPick(projectId: string): void;
  onAdd(): void;
  onClose(): void;
}

/** "All projects" (§3.5, PH13): Launch asks which project first. The first choice takes the focus; Escape closes it. */
export default function ProjectPicker({ projects, onPick, onAdd, onClose }: ProjectPickerProps) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const scratch = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const openScratch = () =>
    void scratch.run(async () => {
      setProblem(null);
      try {
        const { project } = await getRuntime().rpc.call("projects.scratch", {});
        holdProject(project);
        onPick(project.id);
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
  }, []);
  return (
    <div
      ref={box}
      role="group"
      aria-label={t("home.picker.label")}
      data-project-picker=""
      className="flex flex-col gap-s2 rounded-sm border border-border bg-surface p-s3"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <p className="label-hud text-muted">{t("home.picker.label")}</p>
      <div className="flex flex-wrap gap-s2">
        {projects.map((project) => (
          <Button key={project.id} size="sm" onClick={() => onPick(project.id)}>
            {project.name}
          </Button>
        ))}
        <Button
          size="sm"
          remote={false}
          disabled={scratch.since !== null}
          pendingSince={scratch.since}
          aria-describedby={hintId}
          onClick={openScratch}
        >
          {t("boxes.picker.scratch")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onAdd}>
          {t("home.picker.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("home.picker.cancel")}
        </Button>
      </div>
      <p id={hintId} className="text-ui text-muted">
        {t("boxes.picker.scratchHint")}
      </p>
      {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
    </div>
  );
}

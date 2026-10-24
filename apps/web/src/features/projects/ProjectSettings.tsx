import "../../i18n/register-boxes.ts";
import { Button, Chip, toast, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { phaseOf } from "../../stores/box-phase.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxFailure } from "../boxes/box-errors.ts";
import { BoxStart } from "../boxes/BoxStart.tsx";
import { HostsField } from "../boxes/HostsField.tsx";
import { PhaseChip } from "../boxes/PhaseChip.tsx";
import { ResourceFields } from "../boxes/ResourceFields.tsx";
import { useBoxAction } from "../boxes/use-box-action.ts";
import { packagesChanged, useProjectBox } from "../boxes/use-project-box.ts";
import { ProjectGithubSettings } from "../github/ProjectGithubSettings.tsx";
import { DeleteProjectDialog } from "./DeleteProjectDialog.tsx";
import { draftOf, type SettingsDraft, toSetBox } from "./project-settings.vm.ts";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-s2">
      <h3 className="label-hud text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** One package list, in mono with tabular figures (versions), under its label. */
function PackageList({
  label,
  names,
  none,
}: {
  readonly label: string;
  readonly names: readonly string[];
  readonly none: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-s1">
      <span className="label-hud text-muted">{label}</span>
      <p className="break-words font-mono text-code tabular-nums text-fg">
        {names.length === 0 ? none : names.join(", ")}
      </p>
    </div>
  );
}

interface Props {
  readonly projectId: string;
  onClose(): void;
}

/**
 * A box project's settings (BOX, RESOURCES, HOSTS, PACKAGES, then the irreversible one): a dialog over the page, loaded on
 * first use. Resources apply at the next start; the disk can only grow; a project's hosts are its own and add to the owner's list.
 */
export function ProjectSettings({ projectId, onClose }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const project = useShellStore((state) => state.view.projects.get(projectId));
  const phase = project === undefined ? "stopped" : phaseOf(project);
  const { state, replace } = useProjectBox(projectId, phase);
  const restart = useBoxAction("projects.restartBox", projectId);
  const rebuild = useBoxAction("projects.rebuild", projectId);
  const saving = usePendingAction();
  const [edited, setEdited] = useState<SettingsDraft | null>(null);
  const [errors, setErrors] = useState<Readonly<Partial<Record<string, MessageKey>>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const box = state.kind === "ready" ? state.box : null;
  // What the person typed outlives a re-read of the box (a phase change); a save starts the form again from the daemon's word.
  const draft = edited ?? (box === null ? null : draftOf(box));
  const change = (patch: Partial<SettingsDraft>) => {
    if (draft === null) return;
    setEdited({ ...draft, ...patch });
    setErrors({});
  };

  const save = () => {
    if (box === null || draft === null) return;
    const built = toSetBox(draft, box.resources.diskMb);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    void saving.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const answer = await rpc.call(
          "projects.setBox",
          { projectId, resources: built.resources, hosts: [...built.hosts] },
          { commandId: rpc.newCommandId() },
        );
        replace(answer.box);
        setEdited(null);
        toast({ message: t("boxes.settings.saved") });
      } catch (failure) {
        setProblem(t(boxFailure(failure)));
      }
    });
  };

  const name = project?.name ?? "";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("boxes.settings.heading", { name })}
      closeLabel={t("ui.close")}
      footer={
        <>
          <Button variant="primary" disabled={box === null} pendingSince={saving.since} onClick={save}>
            {t("boxes.settings.save")}
          </Button>
        </>
      }
    >
      <div data-project-settings="" className="flex flex-col gap-s4 p-s3">
        {state.kind === "loading" ? (
          <p role="status" className="text-ui text-muted">
            {t("boxes.settings.loading")}
          </p>
        ) : null}
        {state.kind === "failed" ? (
          <p role="status" className="text-ui text-err">
            {t("boxes.settings.failed")}
          </p>
        ) : null}
        {box !== null && draft !== null ? (
          <>
            <Section title={t("boxes.section.box")}>
              <div className="flex flex-wrap items-center gap-s2">
                <PhaseChip phase={phase} live={false} />
                {phase === "stopped" ? (
                  <BoxStart projectId={projectId} phase={phase} size="sm" />
                ) : (
                  <Button
                    size="sm"
                    disabled={phase !== "running"}
                    pendingSince={restart.since}
                    onClick={restart.run}
                  >
                    {t("boxes.restart")}
                  </Button>
                )}
              </div>
              {restart.problem === null ? null : (
                <p role="status" className="text-ui text-err">
                  {restart.problem}
                </p>
              )}
            </Section>
            <div className="flex flex-col gap-s2">
              <ResourceFields
                draft={draft}
                errors={errors}
                legend={t("boxes.section.resources")}
                set={change}
              />
              <p className="text-ui text-muted">{t("boxes.resources.hint")}</p>
            </div>
            <Section title={t("boxes.section.hosts")}>
              <HostsField
                hint={t("boxes.hosts.hint")}
                value={draft.hosts}
                error={errors["hosts"] === undefined ? null : t(errors["hosts"])}
                onChange={(hosts) => change({ hosts })}
              />
            </Section>
            <Section title={t("boxes.section.packages")}>
              <PackageList
                label={t("boxes.packages.built")}
                names={box.packages.built}
                none={t("boxes.packages.none")}
              />
              {packagesChanged(box) ? (
                <div className="flex flex-col items-start gap-s2">
                  <PackageList
                    label={t("boxes.packages.wanted")}
                    names={box.packages.wanted ?? []}
                    none={t("boxes.packages.noneWanted")}
                  />
                  <Chip tone="att" label={t("boxes.packagesChanged")} />
                  <p className="text-ui text-fg">{t("boxes.packages.notice")}</p>
                </div>
              ) : null}
              <div>
                <Button size="sm" pendingSince={rebuild.since} onClick={rebuild.run}>
                  {t("boxes.rebuild")}
                </Button>
              </div>
              {rebuild.problem === null ? null : (
                <p role="status" className="text-ui text-err">
                  {rebuild.problem}
                </p>
              )}
            </Section>
            <Section title={t("github.link.section")}>
              <ProjectGithubSettings projectId={projectId} />
            </Section>
            {problem === null ? null : (
              <p role="status" className="text-ui text-err">
                {problem}
              </p>
            )}
            <div>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                {t("boxes.delete")}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      {deleting && box !== null ? (
        <DeleteProjectDialog
          project={{ id: projectId, name }}
          counts={box.counts}
          scratch={box.scratch}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            // The shell stream drops the project and its sessions; the page that showed one of them goes home.
            onClose();
            void navigate({ to: "/" });
          }}
        />
      ) : null}
    </Dialog>
  );
}

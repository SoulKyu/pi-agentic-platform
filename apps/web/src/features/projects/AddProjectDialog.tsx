import "./register-add-project-catalog.ts";
import "../../i18n/register-github.ts";
import { Button, Segmented, TextField, usePendingAction } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { holdProject } from "../../stores/shell-store.ts";
import { RepositoryPicker } from "../github/RepositoryPicker.tsx";
import { useCreateFromGithub } from "../github/use-create-from-github.ts";
import { addProjectFailure, projectNameOf } from "./add-project.vm.ts";

interface Props {
  onClose(): void;
  /** The project was created: the host switches the chip to it and lets the asker go on. */
  onAdded(projectId: string): void;
}

/**
 * New project (decision 85, §3.6; boxes lot B1): a name, Create. `projects.create` makes the project and its box; its
 * files live there, not on this machine. Errors are the daemon's codes in words.
 */
export function AddProjectDialog({ onClose, onAdded }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const pending = usePendingAction();
  const [source, setSource] = useState<"empty" | "github">("empty");
  const [repository, setRepository] = useState("");
  const fromGithub = useCreateFromGithub(onAdded);
  const busy = pending.since !== null || fromGithub.since !== null;

  const create = () => {
    const clean = projectNameOf(name);
    if (clean === null) {
      setProblem("addProject.nameEmpty");
      return;
    }
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const { project } = await rpc.call(
          "projects.create",
          { name: clean },
          { commandId: rpc.newCommandId() },
        );
        holdProject(project);
        onAdded(project.id);
      } catch (failure) {
        setProblem(addProjectFailure(failure));
      }
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("addProject.title")}
      closeLabel={t("ui.close")}
      footer={
        <Fragment>
          <Button onClick={onClose}>{t("addProject.cancel")}</Button>
          {source === "github" ? (
            <>
              <Button
                disabled={busy}
                pendingSince={fromGithub.mode === "fork" ? fromGithub.since : null}
                onClick={() => fromGithub.run(repository, "fork")}
              >
                {t("github.fork")}
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                pendingSince={fromGithub.mode === "clone" ? fromGithub.since : null}
                onClick={() => fromGithub.run(repository, "clone")}
              >
                {t("github.clone")}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              remote={false}
              disabled={pending.since !== null}
              pendingSince={pending.since}
              onClick={create}
            >
              {t("addProject.create")}
            </Button>
          )}
        </Fragment>
      }
    >
      <form
        data-add-project=""
        className="flex flex-col gap-s3 p-s3"
        onSubmit={(event) => {
          event.preventDefault();
          if (source === "github") fromGithub.run(repository, "clone");
          else create();
        }}
      >
        <Segmented
          label={t("github.source.label")}
          value={source}
          options={[
            { value: "empty", label: t("github.source.empty") },
            { value: "github", label: t("github.source.github") },
          ]}
          onChange={(next) => setSource(next === "github" ? "github" : "empty")}
        />
        {source === "github" ? (
          <RepositoryPicker
            value={repository}
            error={fromGithub.problem}
            onChange={(next) => {
              setRepository(next);
              fromGithub.clear();
            }}
          />
        ) : (
          <TextField
            label={t("addProject.name")}
            hint={t("addProject.nameHint")}
            value={name}
            name="name"
            autoComplete="off"
            error={problem === null ? null : t(problem)}
            onChange={(next) => {
              setName(next);
              setProblem(null);
            }}
          />
        )}
      </form>
    </Dialog>
  );
}

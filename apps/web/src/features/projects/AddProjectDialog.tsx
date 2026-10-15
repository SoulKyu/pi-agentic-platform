import "./register-add-project-catalog.ts";
import type { ProjectView } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { Fragment, useEffect, useRef, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { holdProject } from "../../stores/shell-store.ts";
import { addProjectFailure, isAbsolutePath } from "./add-project.vm.ts";

interface Props {
  onClose(): void;
  /** The project was added: the host switches the chip to it and lets the asker go on. */
  onAdded(projectId: string): void;
}

interface Checked {
  readonly project: ProjectView;
  /** `lanes.preview`'s answer; null when it could not be read. */
  readonly git: boolean | null;
}

/**
 * Add project (decision 85, §3.6): one absolute path, Check, Add. Check calls `projects.add`, which is idempotent, then
 * reads whether the folder is a git repository (PH2); Add switches the chip. Errors are the daemon's codes in words.
 */
export function AddProjectDialog({ onClose, onAdded }: Props) {
  const t = useT();
  const [path, setPath] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);

  // Each Check, each edit of the path and the dialog's unmounting move the token: an answer for an older one is dropped.
  const token = useRef(0);
  useEffect(
    () => () => {
      token.current += 1;
    },
    [],
  );

  // Promise chains, not try/finally: the React Compiler bails out on a finalizer.
  const check = () => {
    if (busy) return;
    if (!isAbsolutePath(path)) {
      setProblem("addProject.notAbsolute");
      return;
    }
    token.current += 1;
    const mine = token.current;
    const current = () => token.current === mine;
    setBusy(true);
    setProblem(null);
    setChecked(null);
    const { rpc } = getRuntime();
    rpc.call("projects.add", { root: path.trim() }).then(
      ({ project }) => {
        // The daemon filed the folder whatever became of this dialog (PH2): the store keeps it.
        holdProject(project);
        if (!current()) return;
        rpc.call("lanes.preview", { projectRoot: project.root }).then(
          (preview) => {
            if (!current()) return;
            setBusy(false);
            setChecked({ project, git: preview.repo });
          },
          () => {
            if (!current()) return;
            setBusy(false);
            setChecked({ project, git: null });
          },
        );
      },
      (failure: unknown) => {
        if (!current()) return;
        setBusy(false);
        setProblem(addProjectFailure(failure));
      },
    );
  };

  const gitLine: MessageKey =
    checked?.git === null ? "addProject.gitUnknown" : checked?.git ? "addProject.git" : "addProject.notGit";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("addProject.title")}
      description={t("addProject.description")}
      closeLabel={t("ui.close")}
      footer={
        <Fragment>
          <Button onClick={onClose}>{t("addProject.cancel")}</Button>
          <Button
            disabled={busy || path.trim() === ""}
            aria-describedby={path.trim() === "" ? "add-project-check-hint" : undefined}
            onClick={check}
          >
            {t(busy ? "addProject.checking" : "addProject.check")}
          </Button>
          <Button
            variant="primary"
            disabled={checked === null || busy}
            aria-describedby={checked === null ? "add-project-add-hint" : undefined}
            onClick={() => {
              if (checked !== null) onAdded(checked.project.id);
            }}
          >
            {t("addProject.add")}
          </Button>
        </Fragment>
      }
    >
      <div data-add-project="" className="flex flex-col gap-s3 p-s3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            check();
          }}
        >
          <TextField
            label={t("addProject.path")}
            hint={t("addProject.pathHint")}
            value={path}
            name="root"
            error={problem === null ? null : t(problem)}
            onChange={(next) => {
              token.current += 1;
              setPath(next);
              setBusy(false);
              setChecked(null);
              setProblem(null);
            }}
          />
        </form>
        {path.trim() === "" ? (
          <p id="add-project-check-hint" className="text-ui text-muted">
            {t("addProject.checkFirst")}
          </p>
        ) : null}
        {checked === null ? (
          <p id="add-project-add-hint" className="text-ui text-muted">
            {t("addProject.addFirst")}
          </p>
        ) : null}
        {checked !== null ? (
          <div role="status" className="flex flex-col gap-s1">
            <p className="break-all font-mono text-code text-fg">
              {t("addProject.root", { root: checked.project.root })}
            </p>
            <p className="text-ui text-muted">{t(gitLine)}</p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

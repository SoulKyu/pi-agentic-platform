import "../../i18n/register-github.ts";
import { Button, InlineError, TextField } from "@pap/ui";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useBoxProjectId } from "../../stores/box-phase.ts";
import { PrDialog } from "./PrDialog.tsx";
import { useGithubAction } from "./use-github-action.ts";
import { useProjectGithub } from "./use-project-github.ts";

type Done = { readonly key: MessageKey; readonly branch: string } | null;

function PushBarBody({ projectId }: { readonly projectId: string }) {
  const t = useT();
  const { state } = useProjectGithub(projectId);
  const push = useGithubAction();
  const [message, setMessage] = useState("");
  const [empty, setEmpty] = useState(false);
  const [done, setDone] = useState<Done>(null);
  const [opening, setOpening] = useState(false);
  if (state.kind !== "ready" || state.github.link === null) return null;
  const { fork } = state.github.link;

  const commitPush = () => {
    if (message.trim() === "") {
      setEmpty(true);
      return;
    }
    push.run(async () => {
      setDone(null);
      const { rpc } = getRuntime();
      const { sha, branch } = await rpc.call(
        "projects.commitPush",
        { projectId, message: message.trim() },
        { commandId: rpc.newCommandId() },
      );
      setDone({ key: sha === null ? "github.commit.nothing" : "github.commit.done", branch });
      if (sha !== null) setMessage("");
    });
  };

  return (
    <div data-push-bar="" className="flex flex-col gap-s2 border-b border-border px-s3 py-s2">
      <div className="flex flex-wrap items-end gap-s2">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("github.commit.field")}
            value={message}
            name="message"
            autoComplete="off"
            error={empty ? t("github.commit.empty") : null}
            onChange={(next) => {
              setMessage(next);
              setEmpty(false);
            }}
            onSubmitShortcut={commitPush}
          />
        </div>
        <Button variant="primary" pendingSince={push.since} onClick={commitPush}>
          {t("github.commitPush")}
        </Button>
        <Button onClick={() => setOpening(true)}>{t("github.prCreate")}</Button>
      </div>
      {fork ? <p className="text-ui text-muted">{t("github.pr.forkHint")}</p> : null}
      {done === null ? null : (
        <p role="status" className="text-ui text-ok">
          {t(done.key, { branch: done.branch })}
        </p>
      )}
      {push.problem === null ? null : <InlineError announce="action">{t(push.problem)}</InlineError>}
      {opening ? <PrDialog projectId={projectId} onClose={() => setOpening(false)} /> : null}
    </div>
  );
}

/** COMMIT AND PUSH and OPEN A PULL REQUEST over the changes of a box project linked to a repository; nothing for any other folder. */
export function PushBar({ root }: { readonly root: string }) {
  const projectId = useBoxProjectId(root);
  return projectId === null ? null : <PushBarBody projectId={projectId} />;
}

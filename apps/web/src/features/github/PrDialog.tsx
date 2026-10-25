import "../../i18n/register-github.ts";
import { Button, InlineError, TextField } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { githubFailure, githubUrl } from "./github-errors.ts";
import { useGithubAction } from "./use-github-action.ts";

const LINK = "text-agent underline focus-ring";

type Outcome =
  | { readonly kind: "created"; readonly number: number; readonly url: string }
  | { readonly kind: "compare"; readonly url: string };

interface Props {
  readonly projectId: string;
  onClose(): void;
}

/**
 * Open a pull request from the box's branch. The answer is either the created request or, for a fork, GitHub's compare
 * page: the person clicks a real link (a new tab, `noopener`), pap never opens it behind their back.
 */
export function PrDialog({ projectId, onClose }: Props) {
  const t = useT();
  const action = useGithubAction();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [empty, setEmpty] = useState<MessageKey | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const create = () => {
    if (title.trim() === "") {
      setEmpty("github.pr.titleEmpty");
      return;
    }
    action.run(async () => {
      const { rpc } = getRuntime();
      setOutcome(
        await rpc.call(
          "projects.prCreate",
          { projectId, title: title.trim(), body },
          { commandId: rpc.newCommandId() },
        ),
      );
    });
  };
  const href = outcome === null ? null : githubUrl(outcome.url);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("github.pr.title")}
      closeLabel={t("ui.close")}
      footer={
        outcome === null ? (
          <>
            <Button onClick={onClose}>{t("account.cancel")}</Button>
            <Button variant="primary" pendingSince={action.since} onClick={create}>
              {t("github.prCreate")}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t("github.close")}</Button>
        )
      }
    >
      <div data-pr-dialog="" className="flex flex-col gap-s3 p-s3">
        {outcome === null ? (
          <>
            <TextField
              label={t("github.pr.titleField")}
              value={title}
              name="title"
              autoComplete="off"
              error={empty === null ? null : t(empty)}
              onChange={(next) => {
                setTitle(next);
                setEmpty(null);
              }}
            />
            <TextField
              label={t("github.pr.bodyField")}
              value={body}
              name="body"
              multiline
              rows={5}
              onChange={setBody}
            />
            {action.problem === null ? null : (
              <InlineError announce="action">{t(action.problem)}</InlineError>
            )}
          </>
        ) : (
          <div role="status" className="flex flex-col gap-s2 text-ui text-fg">
            <p>
              {outcome.kind === "created"
                ? t("github.pr.created", { number: outcome.number })
                : t("github.pr.forkHint")}
            </p>
            {href === null ? (
              <p className="text-ui text-err">{t(githubFailure(new RpcError("github_unavailable")))}</p>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
                {t(outcome.kind === "created" ? "github.pr.view" : "github.pr.compareLink")}
              </a>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

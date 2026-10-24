import "../../i18n/register-github.ts";
import { RepoFullName, type ProjectGithubView } from "@pap/contracts";
import { Button, Chip, type ChipTone } from "@pap/ui";
import { useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { githubFailure } from "./github-errors.ts";
import { RepositoryPicker } from "./RepositoryPicker.tsx";
import { useGithubAction } from "./use-github-action.ts";
import { useProjectGithub } from "./use-project-github.ts";

const KEY_TONE: Record<ProjectGithubView["key"], ChipTone> = {
  absent: "mut",
  added: "ok",
  failed: "err",
  removing: "run",
};

/**
 * The GITHUB section of a box project's settings: link a repository (typed or picked) or unlink it, and the state of the
 * signing key pap put on GitHub for it. A missing key is neutral, a failed one is the only red.
 */
export function ProjectGithubSettings({ projectId }: { readonly projectId: string }) {
  const t = useT();
  const { state, reload, replace } = useProjectGithub(projectId);
  const link = useGithubAction(true);
  const unlink = useGithubAction();
  const [repository, setRepository] = useState("");
  const [invalid, setInvalid] = useState<MessageKey | null>(null);

  if (state.kind === "loading") return null;
  if (state.kind === "failed")
    return (
      <p role="status" className="text-ui text-muted">
        {t(githubFailure(new RpcError(state.code)))}
      </p>
    );
  const { github } = state;

  const doLink = () => {
    const parsed = RepoFullName.safeParse(repository.trim());
    if (!parsed.success) {
      setInvalid("github.repo.invalid");
      return;
    }
    link.run(async () => {
      const { rpc } = getRuntime();
      const answer = await rpc.call(
        "projects.linkGithub",
        { projectId, repository: parsed.data },
        { commandId: rpc.newCommandId() },
      );
      replace(answer.github);
    });
  };
  const doUnlink = () =>
    unlink.run(async () => {
      const { rpc } = getRuntime();
      await rpc.call("projects.unlinkGithub", { projectId }, { commandId: rpc.newCommandId() });
      setRepository("");
      reload();
    });

  return (
    <div data-github-link="" className="flex flex-col gap-s2">
      {github.link === null ? (
        <>
          <p className="text-ui text-muted">{t("github.link.none")}</p>
          <RepositoryPicker
            value={repository}
            error={invalid}
            onChange={(next) => {
              setRepository(next);
              setInvalid(null);
              link.clear();
            }}
          />
          <div>
            <Button pendingSince={link.since} onClick={doLink}>
              {t("github.link")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="break-words text-ui text-fg">
            {t("github.link.linked", { repository: github.link.repository })}
          </p>
          <div className="flex flex-wrap items-center gap-s2">
            <span className="label-hud text-muted">{t("github.key.label")}</span>
            <Chip tone={KEY_TONE[github.key]} label={t(`github.key.${github.key}`)} />
          </div>
          {github.key === "failed" ? <p className="text-ui text-err">{t("github.key.failedHint")}</p> : null}
          <div>
            <Button variant="danger" pendingSince={unlink.since} onClick={doUnlink}>
              {t("github.unlink")}
            </Button>
          </div>
        </>
      )}
      {(link.problem ?? unlink.problem) === null ? null : (
        <p role="status" className="text-ui text-err">
          {t((link.problem ?? unlink.problem) as MessageKey)}
        </p>
      )}
    </div>
  );
}

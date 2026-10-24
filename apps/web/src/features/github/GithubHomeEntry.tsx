import "../../i18n/register-github.ts";
import { Button } from "@pap/ui";
import { useId, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { CloneNotice } from "./CloneNotice.tsx";
import { GithubTab } from "./GithubTab.tsx";
import { useProjectGithub } from "./use-project-github.ts";

interface Props {
  readonly projectId: string;
  /** Opens the session `sendToSession` made; the shell's actions give it. */
  onOpenSession(sessionId: string): void;
}

/**
 * The GitHub part of a box project's page: the clone's notice (running or failed), and, only for a project linked to a
 * repository, the GITHUB tab behind a disclosure. A server without a GitHub App shows nothing: there is nothing to do here.
 */
export function GithubHomeEntry({ projectId, onOpenSession }: Props) {
  const t = useT();
  const { state, reload } = useProjectGithub(projectId);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (state.kind === "loading") return null;
  if (state.kind === "failed") {
    if (state.code === "github_unavailable" || state.code === "not_found") return null;
    return (
      <section data-github="" className="flex flex-wrap items-center gap-s2">
        <p role="status" className="text-ui text-muted">
          {t("github.tab.failed")}
        </p>
        <Button variant="ghost" size="sm" onClick={reload}>
          {t("github.refresh")}
        </Button>
      </section>
    );
  }
  const { github } = state;
  if (github.link === null && github.clone === null) return null;
  return (
    <section data-github="" className="flex min-w-0 flex-col gap-s2">
      {github.clone === null || github.link === null ? null : (
        <CloneNotice
          projectId={projectId}
          repository={github.link.repository}
          clone={github.clone}
          onRetried={reload}
        />
      )}
      {github.link === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-s2">
            <span className="label-hud text-muted">{t("github.tab.label")}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((was) => !was)}
            >
              <span className="font-mono normal-case">{github.link.repository}</span>
            </Button>
          </div>
          <div id={panelId} hidden={!open}>
            {open ? (
              <GithubTab
                projectId={projectId}
                github={github}
                onRefresh={reload}
                onOpenSession={onOpenSession}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

import "../../i18n/register-github.ts";
import type { ProjectGithubView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import type { ReactNode } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { PullRow } from "./PullRow.tsx";
import { sourceKey, useSendToSession } from "./use-send-to-session.ts";

interface Props {
  readonly projectId: string;
  readonly github: ProjectGithubView;
  onRefresh(): void;
  /** Opens the session `sendToSession` made; the shell's actions give it (features never import each other). */
  onOpenSession(sessionId: string): void;
}

function Section({
  title,
  empty,
  children,
}: {
  readonly title: string;
  readonly empty: MessageKey | null;
  readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="flex min-w-0 flex-col gap-s1">
      <h3 className="label-hud text-muted">{title}</h3>
      {empty === null ? (
        <ul className="flex flex-col">{children}</ul>
      ) : (
        <p className="text-ui text-muted">{t(empty)}</p>
      )}
    </section>
  );
}

/**
 * The project's GitHub tab: open pull requests with their checks, open issues and the latest releases. Everything GitHub
 * wrote (titles, authors, labels, check names, logs) is plain text, never markdown or HTML; a log sits in the fence.
 */
export function GithubTab({ projectId, github, onRefresh, onOpenSession }: Props) {
  const t = useT();
  const send = useSendToSession(projectId, onOpenSession);
  return (
    <div data-github-tab="" className="flex min-w-0 flex-col gap-s3">
      <div className="flex flex-wrap items-center gap-s2">
        {github.link === null ? null : (
          <span className="min-w-0 break-words font-mono text-code text-fg">{github.link.repository}</span>
        )}
        {github.link?.upstream == null ? null : (
          <Chip tone="mut" label={t("github.tab.fork", { upstream: github.link.upstream })} />
        )}
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t("github.refresh")}
        </Button>
      </div>
      <Section title={t("github.pulls")} empty={github.pulls.length === 0 ? "github.none.pulls" : null}>
        {github.pulls.map((pull) => (
          <PullRow
            key={pull.number}
            projectId={projectId}
            pull={pull}
            sending={send.sending}
            since={send.since}
            onSend={send.send}
          />
        ))}
      </Section>
      <Section title={t("github.issues")} empty={github.issues.length === 0 ? "github.none.issues" : null}>
        {github.issues.map((issue) => (
          <li
            key={issue.number}
            className="flex min-w-0 flex-wrap items-center gap-x-s2 border-b border-border py-s2 text-ui text-muted"
          >
            <span className="font-mono tabular-nums">{`#${issue.number}`}</span>
            <span className="min-w-0 break-words">{issue.title}</span>
            <span>{t("github.by", { author: issue.author })}</span>
            {issue.labels.length === 0 ? null : <span className="font-mono">{issue.labels.join(", ")}</span>}
            <Button
              size="sm"
              disabled={send.since !== null}
              pendingSince={
                send.sending === sourceKey({ kind: "issue", number: issue.number }) ? send.since : null
              }
              onClick={() => send.send({ kind: "issue", number: issue.number })}
            >
              {t("github.sendToSession")}
            </Button>
          </li>
        ))}
      </Section>
      <Section
        title={t("github.releases")}
        empty={github.releases.length === 0 ? "github.none.releases" : null}
      >
        {github.releases.map((release) => (
          <li
            key={release.tag}
            className="flex min-w-0 flex-wrap items-center gap-x-s2 border-b border-border py-s2 text-ui text-muted"
          >
            <span className="font-mono">{release.tag}</span>
            <span className="min-w-0 break-words">{release.name}</span>
            {release.publishedAt === null ? null : (
              <span className="font-mono tabular-nums">{release.publishedAt.slice(0, 10)}</span>
            )}
            {release.assets.length === 0 ? null : (
              <span className="min-w-0 break-words font-mono">
                {release.assets.map((asset) => asset.name).join(", ")}
              </span>
            )}
          </li>
        ))}
      </Section>
      {send.problem === null ? null : (
        <p role="status" className="text-ui text-err">
          {t(send.problem)}
        </p>
      )}
    </div>
  );
}

import "../../i18n/register-github.ts";
import type { ProjectGithubView } from "@pap/contracts";
import { Banner, Button, Chip } from "@pap/ui";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useGithubAction } from "./use-github-action.ts";

const REASONS = {
  auth: "github.clone.reason.auth",
  network: "github.clone.reason.network",
  not_found: "github.clone.reason.not_found",
  failed: "github.clone.reason.failed",
} as const satisfies Record<string, MessageKey>;

/** The daemon's fixed word for why a clone failed, in words; a word it does not know says the generic one. */
const reasonKey = (error: string | null): MessageKey =>
  error !== null && Object.hasOwn(REASONS, error) ? REASONS[error as keyof typeof REASONS] : REASONS.failed;

interface Props {
  readonly projectId: string;
  readonly repository: string;
  readonly clone: NonNullable<ProjectGithubView["clone"]>;
  /** The clone started again: read the project's GitHub view anew. */
  onRetried(): void;
}

/** A clone that runs (a chip, neutral work), or one that failed (the one red thing here) with RETRY; done says nothing. */
export function CloneNotice({ projectId, repository, clone, onRetried }: Props) {
  const t = useT();
  const retry = useGithubAction();
  if (clone.state === "done") return null;
  if (clone.state === "pending")
    return (
      <div role="status" className="flex flex-wrap items-center gap-s2 text-ui text-muted">
        <Chip tone="run" label={t("github.clone.chip")} dot />
        {t("github.clone.pending", { repository })}
      </div>
    );
  const again = () =>
    retry.run(async () => {
      const { rpc } = getRuntime();
      await rpc.call("projects.cloneAgain", { projectId }, { commandId: rpc.newCommandId() });
      onRetried();
    });
  return (
    <Banner
      tone="crash"
      title={t("github.clone.failed", { repository, reason: t(reasonKey(clone.error)) })}
      actions={
        <Button variant="primary" size="sm" pendingSince={retry.since} onClick={again}>
          {t("github.retry")}
        </Button>
      }
    >
      {retry.problem === null ? null : <p className="text-ui text-err">{t(retry.problem)}</p>}
    </Banner>
  );
}

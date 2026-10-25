import type { VcsFile } from "@pap/contracts";
import { Banner, Button, LoadingLine } from "@pap/ui";
import { DiffView, languageFor } from "@pap/ui/code";
import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import "../../i18n/register-launch.ts";
import { useBoxCauseText } from "../../stores/loading-cause.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { absolutePath, countsOf, rowPath } from "./changes.vm.ts";
import { useFileDiff, type DiffTarget } from "./use-file-diff.ts";

interface FileDiffProps {
  readonly root: string;
  readonly file: VcsFile;
  onOpenFile(path: string): void;
}

const Note = ({ children }: { readonly children: string }) => (
  <p role="status" className="p-s3 text-ui text-muted">
    {children}
  </p>
);

/** The content moved when any of these did; the status clock alone moves every poll and must not reload the diff. */
const signatureOf = (file: VcsFile): string =>
  [file.kind, file.index, file.worktree, file.additions, file.deletions].join("|");

/** One changed file against the last commit: the merge view, or the reason there is none (binary, too large, folder). */
export function FileDiff({ root, file, onOpenFile }: FileDiffProps) {
  const t = useT();
  const cause = useBoxCauseText(t, root);
  const [attempt, setAttempt] = useState(0);
  const skip = file.folder || file.binary;
  const target: DiffTarget | null = skip
    ? null
    : { path: file.path, oldPath: file.oldPath, signature: signatureOf(file) };
  const state = useFileDiff(root, target, attempt);
  const language = useMemo(() => languageFor(file.path), [file.path]);
  const labels = useMemo(
    () => ({ label: t("changes.diff.label"), noChanges: t("changes.diff.noChanges") }),
    [t],
  );

  let body;
  if (file.folder) {
    body = <Note>{t("changes.diff.folder")}</Note>;
  } else if (file.binary || (state.phase === "ready" && state.diff.binary)) {
    body = <Note>{t("changes.diff.binary")}</Note>;
  } else if (state.phase === "error") {
    body = (
      <div className="p-s3">
        <Banner
          tone="capacity"
          title={state.code === "timeout" ? t("changes.diff.timeout") : t("changes.diff.failed")}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              {t("changes.diff.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (state.phase === "ready" && state.diff.truncated) {
    body = (
      <div className="flex flex-col items-start gap-s2 p-s3">
        <p role="status" className="text-ui text-muted">
          {t("changes.diff.tooLarge")}
        </p>
        <Button variant="secondary" size="sm" onClick={() => onOpenFile(absolutePath(root, file.path))}>
          {t("changes.diff.openInFiles")}
        </Button>
      </div>
    );
  } else if (state.phase === "ready") {
    body = (
      <DiffView
        before={state.diff.before}
        after={state.diff.after}
        language={language}
        labels={labels}
        onLoadError={() => reportClientIssue("lazy_chunk_failed")}
      />
    );
  } else {
    body = (
      <div className="p-s3">
        <LoadingLine label={t("changes.diff.loading")} cause={cause} />
      </div>
    );
  }

  const counts = countsOf(file);
  return (
    <div data-slot="file-diff" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-s2 border-b border-border px-s3 py-s1">
        <span data-slot="file-name" className="min-w-0 truncate font-mono text-code text-muted">
          {rowPath(file)}
        </span>
        {counts === null ? null : (
          <span className="font-mono text-code tabular-nums text-muted">{counts}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}

import type { ReviewDoc } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import { cn, FOCUS_RING, formatDiffCounts, Icon, IconCheck, ProgressBar } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import "./register-review-catalog.ts";
import { isSeen, progressOf, STATUS_KEYS } from "./review.vm.ts";

interface ReviewFilesProps {
  readonly files: readonly ReviewFile[];
  readonly doc: ReviewDoc;
  readonly selected: string | null;
  readonly truncated: boolean;
  onSelect(path: string): void;
  onSeen(file: ReviewFile, seen: boolean): void;
}

function SeenBox({
  file,
  seen,
  onChange,
}: {
  file: ReviewFile;
  seen: boolean;
  onChange(seen: boolean): void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={seen}
      aria-label={t("lanes.review.seen.file", { path: escapeHidden(file.path) })}
      onClick={() => onChange(!seen)}
      className="flex shrink-0 cursor-pointer items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          seen ? "border-you-fill bg-you-fill text-you-ink" : "border-control-border bg-bg",
        )}
      >
        {seen ? <Icon icon={IconCheck} size={14} /> : null}
      </span>
    </button>
  );
}

/** Keys: Up and Down move between the files (the focus stays on a row), Enter or Space opens one. */
function moveFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-review-file]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  const next = rows[event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** The changed files (board 10): Seen box, path, `+a −d` or "binary", and the status as a word. */
export function ReviewFiles({ files, doc, selected, truncated, onSelect, onSeen }: ReviewFilesProps) {
  const t = useT();
  const progress = progressOf(doc, files);
  return (
    <nav aria-label={t("lanes.review.files.label")} className="flex flex-col" onKeyDown={moveFocus}>
      <div className="flex items-center justify-between gap-s2 px-s3 pt-s2 text-ui text-muted">
        <span className="label-hud">
          {t("lanes.review.seen.progress", { seen: progress.seen, total: progress.total })}
        </span>
        {progress.comments > 0 ? (
          <span>
            {progress.comments === 1
              ? t("lanes.review.comments.one")
              : t("lanes.review.comments.many", { count: progress.comments })}
          </span>
        ) : null}
      </div>
      <div className="px-s3 py-s1">
        <ProgressBar
          value={progress.seen}
          max={Math.max(progress.total, 1)}
          label={t("lanes.review.seen.bar")}
          tone="you"
        />
      </div>
      {truncated ? <p className="px-s3 text-ui text-muted">{t("lanes.review.truncated")}</p> : null}
      <ul className="flex flex-col">
        {files.map((file) => {
          const on = file.path === selected;
          const name =
            file.oldPath === null
              ? escapeHidden(file.path)
              : `${escapeHidden(file.oldPath)} → ${escapeHidden(file.path)}`;
          const counts =
            file.binary || file.additions === null || file.deletions === null
              ? t("lanes.review.file.binary")
              : formatDiffCounts(file.additions, file.deletions);
          return (
            <li
              key={file.path}
              className={cn(
                "flex items-center gap-s2 border-l-2 pl-s2",
                on ? "border-agent bg-surface-2" : "border-transparent",
              )}
            >
              <SeenBox file={file} seen={isSeen(doc, file)} onChange={(seen) => onSeen(file, seen)} />
              <button
                type="button"
                data-review-file={file.path}
                aria-current={on ? "true" : undefined}
                onClick={() => onSelect(file.path)}
                className={cn(
                  "flex min-h-control min-w-0 flex-1 cursor-pointer flex-col justify-center gap-s1 py-s1 pr-s3 text-start text-ui text-fg pointer-coarse:min-h-11",
                  FOCUS_RING,
                  on ? "" : "can-hover:hover:bg-surface",
                )}
              >
                <span className="min-w-0 truncate font-mono text-code">{name}</span>
                <span className="flex items-center gap-s2 text-muted">
                  <span className="font-mono text-code tabular-nums">{counts}</span>
                  <span>{t(STATUS_KEYS[file.status])}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

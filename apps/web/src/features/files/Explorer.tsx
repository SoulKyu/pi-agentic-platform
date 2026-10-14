import { FILE_LIMITS } from "@pap/contracts";
import { Banner, Button, IconButton, IconRefresh, Spinner, Switch } from "@pap/ui";
import { useRef, useState, type KeyboardEvent } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { ExplorerRow } from "./ExplorerRow.tsx";
import { visibleRows, type TreeRow } from "./files.vm.ts";
import { useFolders } from "./use-folders.ts";

const SHOW_IGNORED_KEY = "pap.files.showIgnored";

function readShowIgnored(): boolean {
  try {
    return localStorage.getItem(SHOW_IGNORED_KEY) === "1";
  } catch {
    reportClientIssue("storage_refused");
    return false;
  }
}

function saveShowIgnored(value: boolean): void {
  try {
    localStorage.setItem(SHOW_IGNORED_KEY, value ? "1" : "0");
  } catch {
    reportClientIssue("storage_refused"); // the choice holds for this page
  }
}

interface ExplorerProps {
  readonly root: string;
  /** The file shown in the viewer. */
  readonly selected: string | null;
  onOpen(path: string): void;
}

/** The project tree (WAI-ARIA tree pattern): folders list when they open, the selected file carries the selection mark. */
export function Explorer({ root, selected, onOpen }: ExplorerProps) {
  const t = useT();
  const [showIgnored, setShowIgnored] = useState(readShowIgnored);
  const { expanded, folders, toggle, refresh } = useFolders(root, showIgnored);
  const [focused, setFocused] = useState<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  const rows = visibleRows(root, expanded, folders);
  const rootFolder = folders.get(root);
  const tabbable = rows.some((row) => row.path === focused) ? focused : (rows[0]?.path ?? null);
  const siblings = (row: TreeRow) => {
    const parent = row.path.slice(0, row.path.lastIndexOf("/")) || "/";
    const same = rows.filter((other) => (other.path.slice(0, other.path.lastIndexOf("/")) || "/") === parent);
    return { posInSet: same.indexOf(row) + 1, setSize: same.length };
  };

  const activate = (row: TreeRow) => {
    setFocused(row.path);
    if (row.expandable) toggle(row.path);
    else if (row.openable) onOpen(row.path);
  };
  const focusRow = (path: string | undefined) => {
    if (path === undefined) return;
    setFocused(path);
    tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const index = rows.findIndex((candidate) => candidate.path === target.dataset.path);
    const row = rows[index];
    if (row === undefined) return;
    const handled = (): void => event.preventDefault();
    switch (event.key) {
      case "ArrowDown":
        handled();
        focusRow(rows[Math.min(index + 1, rows.length - 1)]?.path);
        break;
      case "ArrowUp":
        handled();
        focusRow(rows[Math.max(index - 1, 0)]?.path);
        break;
      case "Home":
        handled();
        focusRow(rows[0]?.path);
        break;
      case "End":
        handled();
        focusRow(rows.at(-1)?.path);
        break;
      case "ArrowRight":
        handled();
        if (row.expandable && !row.expanded) toggle(row.path);
        else if (row.expanded) {
          const child = rows[index + 1];
          if (child && child.depth > row.depth) focusRow(child.path);
        }
        break;
      case "ArrowLeft":
        handled();
        if (row.expanded) toggle(row.path);
        else {
          const parent = rows.slice(0, index).findLast((other) => other.depth < row.depth);
          focusRow(parent?.path);
        }
        break;
      default:
    }
  };

  const noteFor = (code: string | undefined) =>
    code === "not_found" ? t("files.explorer.gone") : t("files.explorer.listFailed");
  const failedFolders = [...folders].filter(
    ([path, folder]) => folder.status === "error" && (path === root || expanded.includes(path)),
  );

  return (
    <div data-slot="explorer" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-s2 border-b border-border px-s2 py-s1">
        <Switch
          label={t("files.explorer.showIgnored")}
          checked={showIgnored}
          onChange={(next) => {
            saveShowIgnored(next);
            setShowIgnored(next);
          }}
        />
        <IconButton icon={IconRefresh} label={t("files.explorer.refresh")} size="sm" onClick={refresh} />
      </div>
      <div
        ref={tree}
        role="tree"
        aria-label={t("files.explorer.label")}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto py-s1"
      >
        {rootFolder === undefined ? (
          <div className="flex items-center gap-s2 px-s3 py-s2 text-ui text-muted">
            <Spinner label={t("files.explorer.loading")} />
          </div>
        ) : null}
        {rows.map((row) => (
          <ExplorerRow
            key={row.path}
            row={row}
            selected={row.path === selected}
            loading={row.expanded && !folders.has(row.path)}
            tabbable={row.path === tabbable}
            {...siblings(row)}
            onActivate={activate}
            onFocus={setFocused}
          />
        ))}
      </div>
      {rootFolder?.status === "ready" && rootFolder.entries.length === 0 ? (
        <p className="px-s3 py-s2 text-ui text-muted">{t("files.explorer.empty")}</p>
      ) : null}
      {[...folders.values()].some((folder) => folder.truncated) ? (
        <p role="status" className="px-s3 py-s2 text-ui text-muted">
          {t("files.explorer.truncated", { count: FILE_LIMITS.listEntries })}
        </p>
      ) : null}
      {failedFolders.map(([path, folder]) => (
        <Banner
          key={path}
          tone="capacity"
          title={noteFor(folder.code)}
          actions={
            <Button variant="secondary" size="sm" onClick={refresh}>
              {t("files.viewer.retry")}
            </Button>
          }
        />
      ))}
    </div>
  );
}

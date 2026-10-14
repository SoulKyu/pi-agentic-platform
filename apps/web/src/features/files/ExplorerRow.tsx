import {
  cn,
  FOCUS_RING,
  Icon,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconLock,
  Spinner,
  Tooltip,
} from "@pap/ui";
import type { DragEvent, KeyboardEvent } from "react";
import { useT } from "../../i18n/index.ts";
import type { TreeRow } from "./files.vm.ts";

export const PATH_DRAG_TYPE = "application/x-pap-path";

interface ExplorerRowProps {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly loading: boolean;
  readonly tabbable: boolean;
  readonly posInSet: number;
  readonly setSize: number;
  onActivate(row: TreeRow): void;
  onFocus(path: string): void;
}

/** One tree row. The name is React text; a locked row says why it cannot open, with a tooltip and an accessible name. */
export function ExplorerRow({
  row,
  selected,
  loading,
  tabbable,
  posInSet,
  setSize,
  onActivate,
  onFocus,
}: ExplorerRowProps) {
  const t = useT();
  const lockLabel =
    row.lock === null ? null : t(row.lock === "protected" ? "files.lock.protected" : "files.lock.outside");
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    // The composer reads these two types without importing this feature (M8R77).
    event.dataTransfer.setData(PATH_DRAG_TYPE, row.path);
    event.dataTransfer.setData("text/plain", row.path);
    event.dataTransfer.effectAllowed = "copy";
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(row);
    }
  };
  return (
    <div
      role="treeitem"
      data-path={row.path}
      aria-level={row.depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={selected}
      aria-current={selected ? "true" : undefined}
      aria-busy={loading ? true : undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable
      onDragStart={onDragStart}
      onFocus={() => onFocus(row.path)}
      onClick={() => onActivate(row)}
      onKeyDown={onKeyDown}
      style={{ paddingInlineStart: `calc(var(--space-2) + ${row.depth} * var(--space-3))` }}
      className={cn(
        "flex min-h-control cursor-pointer items-center gap-s1 border-l-2 pe-s2 text-ui pointer-coarse:min-h-11",
        FOCUS_RING,
        selected
          ? "border-agent bg-surface-2 text-fg"
          : "border-transparent text-fg can-hover:hover:bg-surface",
        row.entry.hidden !== null || row.entry.kind === "other" ? "text-muted" : null,
      )}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted">
        {row.expandable ? <Icon icon={row.expanded ? IconChevronDown : IconChevronRight} size={14} /> : null}
      </span>
      <span className="inline-flex shrink-0 text-muted">
        <Icon icon={row.entry.kind === "dir" || row.entry.linkDir ? IconFolder : IconFile} size={14} />
      </span>
      <span data-slot="row-name" className="min-w-0 flex-1 truncate">
        {row.name}
      </span>
      {loading ? <Spinner /> : null}
      {lockLabel === null ? null : (
        <Tooltip label={lockLabel}>
          <span
            data-slot="lock"
            role="img"
            aria-label={lockLabel}
            className="inline-flex shrink-0 text-muted"
          >
            <Icon icon={IconLock} size={14} />
          </span>
        </Tooltip>
      )}
    </div>
  );
}

import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

const TAB_CLASSES =
  "group inline-flex h-bar max-w-56 shrink-0 items-center gap-s1 rounded-sm border px-s2 label-hud transition-colors duration-fast";
const TAB_STATE = {
  active: "border-agent bg-surface-2 text-fg",
  idle: "border-border text-muted can-hover:hover:text-fg",
} as const;
/** Longest title a tab shows whole at the default density; a longer one is truncated and gets a tooltip. */
const FULL_TITLE_MAX = 24;
const STATUS_TONES = { running: "bg-agent-fill", waiting: "bg-attn-fill" } as const;

export interface OpenTabProps {
  readonly tabId: string;
  readonly panelId?: string;
  readonly title: string;
  readonly active: boolean;
  readonly status?: keyof typeof STATUS_TONES | null;
  readonly closeLabel: string;
  onSelect(): void;
  onClose(): void;
}

/** One open item (DESIGN.md §8): mono upper case, agent border and surface-2 fill when active. Closing deletes nothing. */
// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function OpenTab({
  tabId,
  panelId,
  title,
  active,
  status,
  closeLabel,
  onSelect,
  onClose,
}: OpenTabProps) {
  const statusTone = status ?? null;
  const tabButton = (
    <button
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Delete") return;
        event.preventDefault();
        onClose();
      }}
      className="flex min-w-0 items-center gap-s1 focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      {statusTone ? (
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONES[statusTone])} />
      ) : null}
      <span className="truncate">{title}</span>
    </button>
  );
  return (
    <div data-slot="open-tab" className={cn(TAB_CLASSES, active ? TAB_STATE.active : TAB_STATE.idle)}>
      {title.length > FULL_TITLE_MAX ? <Tooltip label={title}>{tabButton}</Tooltip> : tabButton}
      <button
        type="button"
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={onClose}
        className="inline-flex size-4 items-center justify-center rounded-sm text-muted focus-ring can-hover:hover:bg-surface pointer-coarse:size-11"
      >
        <Icon icon={IconClose} size={14} />
      </button>
    </div>
  );
}

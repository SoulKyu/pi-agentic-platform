import { useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { Chip } from "../primitives/Chip.tsx";
import { Collapsible } from "../primitives/Collapsible.tsx";
import { ProgressBar } from "../primitives/ProgressBar.tsx";

export type ToolDetail = "compact" | "expanded" | "full";
export type ToolStatus = "running" | "done" | "error";

const FRAME_TONES = {
  running: "border-border-strong",
  done: "border-border-strong",
  error: "border-err",
} as const;
const BODY_DETAIL = {
  compact: "max-h-64 overflow-auto",
  expanded: "max-h-64 overflow-auto",
  full: "",
} as const;

export interface ToolCardProps {
  readonly name: string;
  readonly summary?: string;
  readonly duration?: string;
  readonly status: ToolStatus;
  /** Settings › Appearance › tool card detail (DESIGN.md §9.2, §13). */
  readonly detail: ToolDetail;
  readonly runningLabel: string;
  readonly failedLabel: string;
  /** A word for a card that is neither running nor failed ("Done", "Waiting"): the state is never colour alone. */
  readonly statusLabel?: string;
  /** The output as text. */
  readonly children?: ReactNode;
  /** Under the output, inside the disclosure: "show the whole output" and its errors. */
  readonly footer?: ReactNode;
}

/** Written from the Pi tool call/result model; AI Elements' tool.tsx was a reference only (S6). */
export function ToolCard({
  name,
  summary,
  duration,
  status,
  detail,
  runningLabel,
  failedLabel,
  statusLabel,
  children,
  footer,
}: ToolCardProps) {
  // The setting decides until the person toggles this card; a later change of the setting is followed until then.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? detail !== "compact";
  const header = (
    <span className="flex min-w-0 flex-1 items-center gap-s2 px-s2 py-s1">
      <span className="label-hud min-w-0 truncate text-agent">{name}</span>
      {summary ? (
        <span className="min-w-0 flex-1 truncate font-mono text-code text-muted">{summary}</span>
      ) : (
        <span className="flex-1" />
      )}
      {status === "error" ? <Chip tone="err" label={failedLabel} /> : null}
      {status !== "error" && status !== "running" && statusLabel ? (
        <span className="shrink-0 text-label text-muted">{statusLabel}</span>
      ) : null}
      {duration ? (
        <span className="shrink-0 font-mono text-label tabular-nums text-muted">{duration}</span>
      ) : null}
    </span>
  );
  return (
    <div
      data-slot="tool-card"
      data-status={status}
      className={cn("rounded-md border bg-surface", FRAME_TONES[status])}
    >
      {children === undefined && footer === undefined ? (
        header
      ) : (
        <Collapsible open={open} onOpenChange={setChosen} trigger={header}>
          {children === undefined ? null : (
            <pre
              className={cn(
                "whitespace-pre-wrap break-words border-t border-border px-s2 py-s1 font-mono text-code text-fg",
                BODY_DETAIL[detail],
              )}
            >
              {children}
            </pre>
          )}
          {footer === undefined ? null : <div className="border-t border-border px-s2 py-s1">{footer}</div>}
        </Collapsible>
      )}
      {status === "running" ? <ProgressBar label={runningLabel} /> : null}
    </div>
  );
}

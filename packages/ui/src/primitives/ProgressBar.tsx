import { cn } from "../cn.ts";

const TONES = { agent: "bg-agent-fill", you: "bg-you-fill" } as const;

export interface ProgressBarProps {
  /** Null or absent: the thin indeterminate bar of a running tool card (DESIGN.md §9.1). */
  readonly value?: number | null;
  readonly max?: number;
  readonly label: string;
  readonly tone?: keyof typeof TONES;
}

// Defaults are read in the body: the React Compiler (Babel 8 AST) bails out on defaults in a destructured parameter.
export function ProgressBar({ value, max, label, tone }: ProgressBarProps) {
  const bar = TONES[tone ?? "agent"];
  const range = max ?? 100;
  if (value === undefined || value === null) {
    return (
      <div
        data-slot="progress"
        role="progressbar"
        aria-label={label}
        className="relative h-0.5 w-full overflow-hidden bg-surface-2"
      >
        <div className={cn("absolute inset-y-0 left-0 w-1/3 animate-indeterminate", bar)} />
      </div>
    );
  }
  const now = Number.isFinite(value) ? Math.min(range, Math.max(0, value)) : 0;
  const percent = range > 0 ? (now / range) * 100 : 0;
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={range}
      aria-valuenow={now}
      className="h-0.5 w-full bg-surface-2"
    >
      <div className={cn("h-full", bar)} style={{ width: `${percent}%` }} />
    </div>
  );
}

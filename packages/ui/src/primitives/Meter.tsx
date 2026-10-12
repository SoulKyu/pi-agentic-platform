import { cn } from "../cn.ts";

const METER_TONES = { tokens: "bg-agent-fill", cost: "bg-you-fill" } as const;

export interface MeterProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly kind: keyof typeof METER_TONES;
  readonly valueText: string;
}

/** DESIGN.md §9.1: tokens are agent, cost is you. The value is clamped to the range (M3R19). */
export function Meter({ label, value, max, kind, valueText }: MeterProps) {
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  const now = Number.isFinite(value) ? Math.min(top, Math.max(0, value)) : 0;
  const percent = top > 0 ? (now / top) * 100 : 0;
  return (
    <div data-slot="meter" className="flex flex-col gap-s1">
      <div className="flex items-baseline justify-between gap-s2">
        <span className="label-hud text-muted">{label}</span>
        <span className="font-mono text-ui tabular-nums text-fg">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={top}
        aria-valuenow={now}
        aria-valuetext={valueText}
        className="h-1 w-full bg-surface-2"
      >
        <div className={cn("h-full", METER_TONES[kind])} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

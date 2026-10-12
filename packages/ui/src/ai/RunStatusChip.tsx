import { Chip, type ChipTone } from "../primitives/Chip.tsx";

export type RunStatus = "working" | "settled" | "interrupted" | "limited" | "needs-input";

const CHIP_BY_STATUS: Record<RunStatus, ChipTone> = {
  working: "run",
  settled: "ok",
  interrupted: "err",
  limited: "mut",
  "needs-input": "att",
};

export function RunStatusChip({ status, label }: { readonly status: RunStatus; readonly label: string }) {
  return (
    <Chip
      tone={CHIP_BY_STATUS[status]}
      label={label}
      dot={status === "working" || status === "needs-input"}
    />
  );
}

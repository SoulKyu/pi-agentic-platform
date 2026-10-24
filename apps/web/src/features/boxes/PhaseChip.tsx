import "../../i18n/register-boxes.ts";
import type { BoxPhase } from "@pap/contracts";
import { Chip, type ChipTone } from "@pap/ui";
import { useT } from "../../i18n/index.ts";

const PHASE_TONE: Readonly<Record<BoxPhase, ChipTone>> = { stopped: "mut", starting: "run", running: "ok" };

/** The box phase as a chip: a stopped box is neutral, never red; the word is the carrier. A polite live region announces a change. */
export function PhaseChip({ phase, live }: { readonly phase: BoxPhase; readonly live: boolean }) {
  const t = useT();
  return (
    <span {...(live ? { role: "status" } : {})}>
      <Chip tone={PHASE_TONE[phase]} label={t(`boxes.phase.${phase}`)} dot />
    </span>
  );
}

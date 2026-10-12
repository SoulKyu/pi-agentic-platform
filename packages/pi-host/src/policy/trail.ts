import { type StageId, type StageVerdict, STAGE_IDS } from "@pap/contracts";

const MAX_REASON = 256;
const LAST_CALL_STAGE: StageId = "04";

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The verdicts of stages 01–04 for one call, built as the pipeline goes and listed in stage order. */
export function createTrail() {
  const verdicts = new Map<StageId, StageVerdict>();
  return {
    add(stage: StageId, outcome: StageVerdict["outcome"], reason?: string): void {
      if (verdicts.has(stage)) throw new RangeError(`stage ${stage} already has a verdict`);
      verdicts.set(stage, {
        stage,
        outcome,
        ...(reason === undefined ? {} : { reason: clipUnits(reason, MAX_REASON) }),
      });
    },
    /** Marks `stage` to 04 as skipped when they have no verdict yet: a block ended the run before them. */
    skipFrom(stage: StageId, reason: string): void {
      for (const id of STAGE_IDS)
        if (id >= stage && id <= LAST_CALL_STAGE && !verdicts.has(id)) this.add(id, "skip", reason);
    },
    list(): StageVerdict[] {
      return [...verdicts.values()].sort((a, b) => a.stage.localeCompare(b.stage));
    },
  };
}

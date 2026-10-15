import type { LaneView } from "@pap/contracts";
import { expect, vi } from "vitest";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { type OutwardBed, startOutwardBed } from "./outward-bed.ts";

/** Turn `n` of a scripted agent: it writes `a.txt` (tracked), then says it is done. Each worker walks the script on its own. */
const turn = (n: number) => [
  { toolCalls: [{ name: "write", args: { path: "a.txt", content: `v${n}\n` }, id: `w${n}` }] },
  { text: `turn ${n} done` },
];
export const STEPS = [1, 2, 3].flatMap(turn);
export const TIMEOUT = 120_000;

export interface CheckpointBed extends OutwardBed {
  readonly lines: Array<Record<string, unknown>>;
  /** Checkpoint ref names of the project, by `for-each-ref` order. */
  refs(): string[];
  prompt(sessionId: string, text: string): Promise<unknown>;
  /** The debug lines that bracket captures, as `<start|end> <before|after>`. */
  captures(): string[];
}

/** A daemon over a real repository whose workers run the scripted agent above; a lane's first turn is its description. */
export async function startCheckpointBed(): Promise<CheckpointBed> {
  const cap = captureLogger();
  const bed = await startOutwardBed([{}], {}, { steps: STEPS, logger: cap.logger });
  return {
    ...bed,
    lines: cap.lines,
    refs: () =>
      bed.repo
        .git(bed.projectRoot, "for-each-ref", "--format=%(refname)", "refs/pap/checkpoints")
        .split("\n")
        .filter(Boolean),
    prompt: (sessionId, text) =>
      bed.owner.call("sessions.prompt", { sessionId, text, streamingBehavior: "followUp" }),
    captures: () =>
      cap.lines.flatMap((line) =>
        line.msg === "checkpoint_capture_start" || line.msg === "checkpoint_capture_end"
          ? [`${line.msg === "checkpoint_capture_start" ? "start" : "end"} ${String(line.phase)}`]
          : [],
      ),
  };
}

/** A lane whose first run is over: its "after" capture ran, and `firstRunEndedAt` and the primary session are on its view. */
export async function readyLane(bed: CheckpointBed): Promise<LaneView> {
  const created = await bed.createLane();
  await vi.waitFor(
    () => {
      const view = bed.views(created.id).at(-1);
      expect(view?.firstRunEndedAt).not.toBeNull();
      expect(view?.primarySessionId).not.toBeNull();
    },
    { timeout: 60_000 },
  );
  return bed.views(created.id).at(-1) as LaneView;
}

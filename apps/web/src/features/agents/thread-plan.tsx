import type { AgentEventView } from "@pap/contracts";
import { DaySeparator } from "@pap/ui";
import type { Interleave } from "../../stores/thread-interleave.ts";
import { EventCard } from "./EventCard.tsx";
import { layoutThread, type Placed } from "./thread-items.vm.ts";

export interface ThreadPlanInput {
  readonly events: readonly AgentEventView[];
  readonly mode: "cards" | "compact";
  /** Puts text in the thread's composer; never sends. */
  onInject(text: string): void;
  dayLabel(at: number): string;
  /** An IANA zone for the day separators; the browser's own when absent. */
  readonly zone?: string;
}

/** The agent's cards and day separators as nodes among the transcript rows (M11R118). */
export function threadInterleave(input: ThreadPlanInput): Interleave {
  const draw = (placed: Placed) =>
    placed.kind === "day" ? (
      <DaySeparator key={placed.key} label={input.dayLabel(placed.at)} />
    ) : (
      <EventCard
        key={placed.key}
        event={placed.event}
        folded={placed.folded}
        mode={input.mode}
        onInject={input.onInject}
      />
    );
  return {
    arrange: (rows, hasOlder) => {
      const layout = layoutThread(rows, input.events, {
        hasOlder,
        ...(input.zone === undefined ? {} : { zone: input.zone }),
      });
      return {
        before: new Map([...layout.before].map(([key, placed]) => [key, placed.map(draw)])),
        after: layout.after.map(draw),
        hidden: layout.hidden,
        breaks: layout.breaks,
      };
    },
  };
}

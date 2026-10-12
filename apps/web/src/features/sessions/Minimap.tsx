import { cn, FOCUS_RING } from "@pap/ui";
import { useEffect, useState } from "react";
import { t, tp } from "../../i18n/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { minimapTurns, rowId } from "./minimap.vm.ts";
import type { TranscriptItem } from "./transcript.vm.ts";

interface MinimapProps {
  /** Prefix of this screen's row ids (`rowId`). */
  readonly scope: string;
  readonly items: readonly TranscriptItem[];
  readonly view: SessionView;
  /** The transcript's own one-at-a-time loader: the minimap has no request path of its own. */
  readonly onLoadOlder: () => void;
}

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A narrow rail beside the transcript: one numbered button per turn, the one in view marked, a stub that pages older turns in. */
export function Minimap({ scope, items, view, onLoadOlder }: MinimapProps) {
  const { hasMore, oldestEntryId, turnsBefore } = view.history;
  const turns = minimapTurns(items, turnsBefore);
  const keys = JSON.stringify(turns.map((turn) => turn.key));
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const order = JSON.parse(keys) as string[];
    const byElement = new Map<Element, string>();
    for (const key of order) {
      const row = document.getElementById(rowId(scope, key));
      if (row) byElement.set(row, key);
    }
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = byElement.get(entry.target);
        if (key === undefined) continue;
        if (entry.isIntersecting) visible.add(key);
        else visible.delete(key);
      }
      // Nothing visible (inside a long turn): the last turn stays marked.
      const first = order.find((key) => visible.has(key));
      if (first !== undefined) setCurrent(first);
    });
    for (const row of byElement.keys()) observer.observe(row);
    return () => observer.disconnect();
  }, [scope, keys]);

  const goTo = (key: string) => {
    document
      .getElementById(rowId(scope, key))
      ?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    setCurrent(key);
  };

  const button = cn("rounded-sm px-2 py-1 font-mono text-label text-muted hover:text-fg", FOCUS_RING);
  return (
    <nav
      aria-label={t("sessions.minimap.label")}
      className="hidden w-14 shrink-0 flex-col items-stretch gap-1 overflow-y-auto md:flex"
    >
      {hasMore && oldestEntryId !== null ? (
        <button type="button" className={button} onClick={onLoadOlder}>
          {tp("sessions.minimap.earlier", turnsBefore)}
        </button>
      ) : null}
      {turns.map((turn) => (
        <button
          key={turn.key}
          type="button"
          aria-label={
            turn.preview
              ? t("sessions.minimap.turn", { number: turn.number, preview: turn.preview })
              : t("sessions.minimap.turnBare", { number: turn.number })
          }
          aria-current={current === turn.key ? "true" : undefined}
          className={cn(button, current === turn.key && "bg-panel text-fg")}
          onClick={() => goTo(turn.key)}
        >
          {turn.number}
        </button>
      ))}
    </nav>
  );
}

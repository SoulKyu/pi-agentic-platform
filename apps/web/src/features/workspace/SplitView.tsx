import { useRef, type PointerEvent, type ReactNode } from "react";
import { clampRatio, ratioAfterKey, ratioBounds, ratioFromPointer } from "./separator.ts";
import { useElementWidth } from "./use-element-width.ts";

const DEFAULT_MIN_PX = 320; // DESIGN.md §8

interface SplitViewProps {
  readonly ratio: number;
  onRatio(ratio: number): void;
  readonly first: ReactNode;
  readonly second: ReactNode;
  /** The separator's accessible name. */
  readonly label: string;
  readonly minPx?: number;
}

const percent = (ratio: number): string => `${Math.round(ratio * 1e4) / 100}%`;

/** Two panes and a draggable, keyboard-operable separator. Below two minimum widths only `first` shows. */
export function SplitView({ ratio, onRatio, first, second, label, minPx }: SplitViewProps) {
  const min = minPx ?? DEFAULT_MIN_PX;
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null); // the pointer id being dragged
  const width = useElementWidth(containerRef);
  const [low, high] = ratioBounds(width, min);

  const pointerRatio = (event: PointerEvent): number =>
    ratioFromPointer(event.clientX, containerRef.current?.getBoundingClientRect().left ?? 0, width, min);
  const end = (event: PointerEvent) => {
    if (drag.current !== event.pointerId) return;
    drag.current = null; // pointerup, pointercancel and lostpointercapture all land here: commit once
    const next = pointerRatio(event);
    if (firstRef.current) firstRef.current.style.flexBasis = percent(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onRatio(next);
  };

  return (
    <div ref={containerRef} data-slot="split-view" className="flex min-h-0 min-w-0 flex-1">
      <div
        ref={firstRef}
        style={width >= min * 2 ? { flexBasis: percent(ratio) } : undefined}
        className={
          width >= min * 2 ? "flex min-h-0 min-w-pane flex-col" : "flex min-h-0 min-w-0 flex-1 flex-col"
        }
      >
        {first}
      </div>
      {width >= min * 2 ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuemin={Math.round(low * 100)}
            aria-valuemax={Math.round(high * 100)}
            aria-valuenow={Math.round(clampRatio(ratio, width, min) * 100)}
            tabIndex={0}
            onKeyDown={(event) => {
              const next = ratioAfterKey(ratio, event.key, event.shiftKey, width, min);
              if (next === null) return;
              event.preventDefault();
              onRatio(next);
            }}
            onPointerDown={(event) => {
              if (drag.current !== null) return; // a second pointer is ignored
              drag.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current !== event.pointerId || !firstRef.current) return;
              firstRef.current.style.flexBasis = percent(pointerRatio(event)); // no store write per move
            }}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
            className="group relative flex w-1.5 shrink-0 cursor-col-resize justify-center bg-transparent focus-ring"
          >
            <span className="w-px bg-border group-hover:bg-agent group-focus-visible:bg-agent" />
          </div>
          <div className="flex min-h-0 min-w-pane flex-1 flex-col">{second}</div>
        </>
      ) : null}
    </div>
  );
}

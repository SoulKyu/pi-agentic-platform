import { useEffect, useRef, useState } from "react";
import { cn } from "../cn.ts";
import { FOCUS_RING } from "../focus.ts";
import { Button } from "../primitives/Button.tsx";
import { InlineError } from "../primitives/InlineError.tsx";
import { AnsiText } from "./AnsiText.tsx";
import { terminalKeyData } from "./terminal-keys.ts";

export interface CustomPanelLabels {
  readonly collapse: string;
  readonly expand: string;
  /** Names the input field. */
  readonly input: string;
  /** How to leave ("Ctrl+] to leave the panel"). */
  readonly leave: string;
  /** Said while the composer holds the focus: how to get to the panel. */
  readonly reach: string;
}

export interface CustomPanelProps {
  /** The open panel's id; without one nothing is shown. A change of id is a new panel. */
  readonly panelId: string | undefined;
  readonly lines: readonly string[];
  /** "2 more waiting", or null when this is the only panel. */
  readonly waitingLabel: string | null;
  /** A failed send, shown once. */
  readonly error: string | null;
  /** The composer has the focus: say how to reach the panel. */
  readonly reachHint: boolean;
  readonly labels: CustomPanelLabels;
  /** Asked when the panel opens or expands: false leaves the focus where it is. */
  shouldTakeFocus(): boolean;
  /** One terminal key (already translated to the bytes a terminal sends). */
  onKeyData(data: string): void;
  /** Typed or pasted text, or an input method's composed text. */
  onText(text: string): void;
  /** Ctrl+], and the panel closing while it held the focus: the caller puts the focus back where it belongs. */
  onLeave(): void;
}

/**
 * An extension's custom panel: its lines in mono, re-rendered whole on each update, and a small input that turns key
 * presses into terminal input. Every key it consumes stays inside (`stopPropagation`), Escape included, so a global
 * Escape never stops the run while a panel has the focus; `data-terminal-input` tells the dispatcher the same.
 */
export function CustomPanel(props: CustomPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const heldFocus = useRef(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const { panelId } = props;

  // The panel closed while it held the focus (Enter or Escape is its normal exit): the caller takes it back.
  useEffect(() => {
    if (!panelId && heldFocus.current) {
      heldFocus.current = false;
      latest.current.onLeave();
    }
  }, [panelId]);
  // Opening or expanding takes the focus, unless the caller says another surface has it.
  useEffect(() => {
    if (panelId && !collapsed && latest.current.shouldTakeFocus()) input.current?.focus();
  }, [panelId, collapsed]);

  if (!panelId) return null;

  return (
    <section className="flex flex-col gap-s2 border-l-2 border-agent px-s3 py-s2">
      <div className="flex items-center gap-s2">
        <span className="label-hud flex-1 text-muted">{props.waitingLabel}</span>
        <Button onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? props.labels.expand : props.labels.collapse}
        </Button>
      </div>
      {collapsed ? null : (
        <div data-terminal-input className="flex flex-col gap-s2">
          <div className="max-h-64 overflow-auto whitespace-pre font-mono text-ui text-fg">
            {props.lines.map((line, index) => (
              // The lines are replaced whole on each update: the index is their identity.
              <div key={index} className="min-h-4">
                <AnsiText text={line} />
              </div>
            ))}
          </div>
          <p className="text-ui text-muted">{props.labels.leave}</p>
          {props.reachHint ? (
            <p role="status" className="text-ui text-muted">
              {props.labels.reach}
            </p>
          ) : null}
          <label className="flex flex-col gap-s1">
            <span className="label-hud text-muted">{props.labels.input}</span>
            <textarea
              ref={input}
              onFocus={() => {
                heldFocus.current = true;
              }}
              onBlur={(event) => {
                if (event.relatedTarget !== null) heldFocus.current = false;
              }}
              rows={1}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(
                "w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-mono text-ui text-fg pointer-coarse:min-h-11 pointer-coarse:text-base",
                FOCUS_RING,
              )}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                const composed = event.currentTarget.value;
                event.currentTarget.value = "";
                props.onText(composed);
              }}
              onChange={(event) => {
                if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
                const typed = event.currentTarget.value;
                event.currentTarget.value = "";
                props.onText(typed);
              }}
              onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                  event.stopPropagation();
                  return;
                }
                if (event.ctrlKey && event.key === "]") {
                  // The way out of a panel that never closes (WCAG 2.1.2); never sent to the worker.
                  event.preventDefault();
                  event.stopPropagation();
                  props.onLeave();
                  return;
                }
                const data = terminalKeyData(event);
                if (data === null) {
                  const typing = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
                  if (typing) event.stopPropagation();
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                props.onKeyData(data);
              }}
            />
          </label>
          {props.error ? <InlineError announce="action">{props.error}</InlineError> : null}
        </div>
      )}
    </section>
  );
}

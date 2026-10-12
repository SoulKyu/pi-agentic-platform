import type { Panel } from "@pap/contracts";
import { UI_LIMITS } from "@pap/contracts";
import { Button, FOCUS_RING } from "@pap/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { AnsiText } from "./AnsiText.tsx";
import { failureText } from "./failure.ts";
import { terminalKeyData } from "./terminal-keys.ts";

/** A paste is cut into chunks of the contract's size; more than this many chunks is refused, not sent (M2R136 follow-up). */
const MAX_PASTE_CHUNKS = 16;

/** The text in chunks of at most `UI_LIMITS.panelInput` UTF-16 units, never cutting a surrogate pair. */
function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + UI_LIMITS.panelInput, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const composerFocused = () => document.activeElement?.closest("[data-composer]") != null;
function subscribeToFocus(notify: () => void): () => void {
  document.addEventListener("focusin", notify);
  document.addEventListener("focusout", notify);
  return () => {
    document.removeEventListener("focusin", notify);
    document.removeEventListener("focusout", notify);
  };
}

/** The input of the open panel, for the composer's Tab; null when no panel shows one. */
let panelInput: HTMLTextAreaElement | null = null;

/** Moves the focus into the open panel; true when there was one to move it to. */
export function focusPanel(): boolean {
  if (!panelInput) return false;
  panelInput.focus();
  return true;
}

/**
 * The oldest open custom panel (`ctx.ui.custom`): its lines in mono, re-rendered whole on each update, and a small
 * input that turns key presses into terminal input. Keys are sent once each and never retried; a failure is shown.
 * Every key it consumes stays inside (`stopPropagation`), Escape included, so a global Escape never stops the run
 * while a panel has the focus (M2R137).
 */
export function CustomPanel(props: { readonly sessionId: string; readonly panels: readonly Panel[] }) {
  const runtime = getRuntime();
  const panel = props.panels[0];
  const [collapsed, setCollapsed] = useState(false);
  const composerHasFocus = useSyncExternalStore(subscribeToFocus, composerFocused);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const panelId = panel?.id;

  // Opening or expanding takes the focus, unless the composer has it: then the panel says how to get there (M2R136).
  useEffect(() => {
    if (panelId && !collapsed && !composerFocused()) input.current?.focus();
  }, [panelId, collapsed]);

  if (!panel) return null;

  const send = (chunks: readonly string[]) => {
    setError(null);
    void (async () => {
      for (const data of chunks) {
        try {
          await runtime.rpc.call("sessions.panelInput", {
            sessionId: props.sessionId,
            panelId: panel.id,
            data,
          });
        } catch (failure) {
          setError(failureText(failure));
          return;
        }
      }
    })();
  };
  const sendText = (typed: string) => {
    if (typed === "") return;
    const chunks = chunksOf(typed);
    if (chunks.length > MAX_PASTE_CHUNKS) {
      setError(t("panel.tooLong"));
      return;
    }
    send(chunks);
  };

  return (
    <section className="flex flex-col gap-2 border-l-2 border-agent px-3 py-2">
      <div className="flex items-center gap-2">
        {props.panels.length > 1 ? (
          <span className="flex-1 font-mono text-label uppercase tracking-label text-muted">
            {t("panel.waiting", { count: props.panels.length - 1 })}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <Button onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? t("panel.expand") : t("panel.collapse")}
        </Button>
      </div>
      {collapsed ? null : (
        <div data-terminal-input className="flex flex-col gap-2">
          <div className="max-h-64 overflow-auto font-mono text-ui whitespace-pre text-fg">
            {panel.lines.map((line, index) => (
              // The lines are replaced whole on each update: the index is their identity.
              <div key={index} className="min-h-4">
                <AnsiText text={line} />
              </div>
            ))}
          </div>
          {composerHasFocus ? (
            <p role="status" className="text-ui text-muted">
              {t("panel.reach")}
            </p>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="font-mono text-label font-semibold uppercase tracking-label text-muted">
              {t("panel.input")}
            </span>
            <textarea
              ref={(element) => {
                input.current = element;
                panelInput = element;
              }}
              rows={1}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`w-full rounded-sm border border-line bg-bg px-2 py-1 font-mono text-ui text-fg ${FOCUS_RING}`}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                const composed = event.currentTarget.value;
                event.currentTarget.value = "";
                sendText(composed);
              }}
              onChange={(event) => {
                if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
                const typed = event.currentTarget.value;
                event.currentTarget.value = "";
                sendText(typed);
              }}
              onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                  event.stopPropagation();
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
                send([data]);
              }}
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui text-attention">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

import type { Panel } from "@pap/contracts";
import { UI_LIMITS } from "@pap/contracts";
import { CustomPanel as CustomPanelView } from "@pap/ui/extensions";
import { useState, useSyncExternalStore } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";

/** A paste longer than this many UTF-16 units is refused, not sent; shorter ones are cut into chunks of the contract's size. */
const MAX_PASTE_UNITS = 16 * UI_LIMITS.panelInput;

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

const composerField = () => document.querySelector<HTMLElement>("[data-composer] textarea");

/**
 * The oldest open custom panel (`ctx.ui.custom`) on the session's wire: the view is `@pap/ui`'s `CustomPanel`; this
 * sends what it hands over. Keys are sent once each and never retried; a failure is shown.
 */
export function CustomPanel(props: { readonly sessionId: string; readonly panels: readonly Panel[] }) {
  const t = useT();
  const runtime = getRuntime();
  const panel = props.panels[0];
  const composerHasFocus = useSyncExternalStore(subscribeToFocus, composerFocused);
  const [error, setError] = useState<string | null>(null);

  const send = (chunks: readonly string[]) => {
    if (!panel) return;
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
    if (typed.length > MAX_PASTE_UNITS) {
      setError(t("panel.tooLong"));
      return;
    }
    send(chunksOf(typed));
  };

  return (
    <CustomPanelView
      panelId={panel?.id}
      lines={panel?.lines ?? []}
      waitingLabel={props.panels.length > 1 ? t("panel.waiting", { count: props.panels.length - 1 }) : null}
      error={error}
      reachHint={composerHasFocus}
      labels={{
        collapse: t("panel.collapse"),
        expand: t("panel.expand"),
        input: t("panel.input"),
        leave: t("panel.leave"),
        reach: t("panel.reach"),
      }}
      shouldTakeFocus={() => !composerFocused()}
      onKeyData={(data) => send([data])}
      onText={sendText}
      onLeave={() => composerField()?.focus()}
    />
  );
}

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { UI_LIMITS, UiResponseRecord } from "@pap/contracts";
import { ANSI_THEME } from "./ansi-theme.ts";
import {
  type CustomPanels,
  createCustomPanels,
  type PanelOutbound,
  type RenderTimers,
} from "./custom-panels.ts";
import { toExtensionErrorRecord } from "./wire-events.ts";
import { messageOf } from "./bounded.ts";
import { boundLines, UI_RECORD_BYTES } from "./ui-lines.ts";
import { createWidgetComponents, type WidgetFactory } from "./widget-components.ts";

export type UiOutbound =
  | ({ type: "extension_ui_request"; id: string; method: string } & Record<string, unknown>)
  | { type: "extension_ui_closed"; id: string }
  | PanelOutbound
  | ReturnType<typeof toExtensionErrorRecord>;

export interface UiBridge {
  readonly context: ExtensionUIContext;
  resolve(response: UiResponseRecord): void;
  /** Keys for an open panel (`custom_input`); an unknown id is ignored. */
  panelInput(id: string, data: string): void;
  panelCancel(id: string): void;
  /** Closes every dialog and panel and clears the component widgets, each settling exactly once. */
  cancelAll(): void;
  pendingCount(): number;
}

export interface UiBridgeOptions {
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Timers of the panels' and widgets' coalesced re-renders (real, unref'ed, by default). */
  renderTimers?: RenderTimers;
}

type Request = Record<string, unknown> & { method: string };

interface PendingDialog {
  answer(response: UiResponseRecord): void;
  close(): void;
}

export function createUiBridge(
  send: (record: UiOutbound) => boolean,
  options: UiBridgeOptions = {},
): UiBridge {
  const newId = options.newId ?? randomUUID;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const pending = new Map<string, PendingDialog>();
  const componentDeps = {
    newId,
    theme: ANSI_THEME,
    ...(options.renderTimers ? { timers: options.renderTimers } : {}),
    onError: (event: string, error: unknown) => {
      try {
        send(toExtensionErrorRecord({ extensionPath: "pi-host:ui", event, error: messageOf(error) }));
      } catch {
        // The daemon link is gone: there is nobody left to tell.
      }
    },
  };
  const panels: CustomPanels = createCustomPanels(send, componentDeps);
  const widgets = createWidgetComponents(send, componentDeps);

  function dialog<T>(
    request: Request,
    fallback: T,
    parse: (response: UiResponseRecord) => T,
    opts?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(fallback);
    const id = newId();
    return new Promise<T>((resolve) => {
      let timer: unknown;
      const close = () => {
        if (!release()) return;
        try {
          send({ type: "extension_ui_closed", id });
        } catch {
          // The daemon link is gone: it can no longer show this dialog anyway.
        }
        resolve(fallback);
      };
      const release = (): boolean => {
        if (!pending.delete(id)) return false;
        if (timer !== undefined) clearTimer(timer);
        opts?.signal?.removeEventListener("abort", close);
        return true;
      };
      pending.set(id, {
        answer: (response) => {
          if (release()) resolve(response.cancelled ? fallback : parse(response));
        },
        close,
      });
      opts?.signal?.addEventListener("abort", close, { once: true });
      if (opts?.timeout) timer = setTimer(close, opts.timeout);
      const sent = (() => {
        try {
          return send({
            type: "extension_ui_request",
            id,
            ...request,
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          });
        } catch {
          return false;
        }
      })();
      // Too large for the channel, or the channel is gone: no answer can come, so the extension gets its fallback now
      // instead of waiting for ever (R106).
      if (!sent && release()) resolve(fallback);
    });
  }

  const fire = (request: Request) => {
    try {
      send({ type: "extension_ui_request", id: newId(), ...request });
    } catch {
      // A decoration nobody can receive must not throw into the extension that asked for it.
    }
  };
  const setWidget = ((key: string, content: unknown, widgetOptions?: { placement?: string }) => {
    const placement = widgetOptions?.placement;
    if (typeof content === "function") {
      widgets.set(key, content as WidgetFactory, placement);
      return;
    }
    // One record per call: a cleared component widget has told the daemon already; a replaced one is overwritten below.
    if (content === undefined ? widgets.clear(key) : (widgets.release(key), false)) return;
    if (content === undefined || Array.isArray(content)) {
      fire({
        method: "setWidget",
        widgetKey: key,
        widgetLines:
          content === undefined
            ? undefined
            : boundLines(content, {
                lines: UI_LIMITS.widgetLines,
                lineChars: UI_LIMITS.widgetLineChars,
                bytes: UI_RECORD_BYTES,
              }),
        ...(placement ? { widgetPlacement: placement } : {}),
      });
    }
  }) as ExtensionUIContext["setWidget"];

  const context: ExtensionUIContext = {
    select: (title, items, opts) =>
      dialog(
        { method: "select", title, options: items },
        undefined,
        (r) => (items.includes(r.value ?? "") ? r.value : undefined),
        opts,
      ),
    confirm: (title, message, opts) =>
      dialog({ method: "confirm", title, message }, false, (r) => r.confirmed === true, opts),
    input: (title, placeholder, opts) =>
      dialog(
        { method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
        undefined,
        (r) => r.value,
        opts,
      ),
    editor: (title, prefill) =>
      dialog(
        { method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
        undefined,
        (r) => r.value,
      ),
    notify: (message, type) => fire({ method: "notify", message, notifyType: type ?? "info" }),
    onTerminalInput: () => () => {},
    setStatus: (key, text) => fire({ method: "setStatus", statusKey: key, statusText: text }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget,
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => fire({ method: "setTitle", title }),
    custom: (factory) => panels.open(factory),
    pasteToEditor: (text) => fire({ method: "set_editor_text", text }),
    setEditorText: (text) => fire({ method: "set_editor_text", text }),
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: ANSI_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are not supported in pap." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    context,
    resolve: (response) => {
      const parsed = UiResponseRecord.safeParse(response);
      if (parsed.success) {
        pending.get(parsed.data.id)?.answer(parsed.data);
        return;
      }
      const id = (response as { id?: unknown } | null)?.id;
      if (typeof id === "string") pending.get(id)?.close();
    },
    panelInput: (id, data) => panels.input(id, data),
    panelCancel: (id) => panels.cancel(id),
    cancelAll: () => {
      for (const dialogHandle of [...pending.values()]) dialogHandle.close();
      panels.cancelAll();
      widgets.clearAll();
    },
    pendingCount: () => pending.size,
  };
}

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { UiResponseRecord } from "@pap/contracts";
import { PLAIN_THEME } from "./plain-theme.ts";

export type UiOutbound =
  | ({ type: "extension_ui_request"; id: string; method: string } & Record<string, unknown>)
  | { type: "extension_ui_closed"; id: string };

export interface UiBridge {
  readonly context: ExtensionUIContext;
  resolve(response: UiResponseRecord): void;
  cancelAll(): void;
  pendingCount(): number;
}

export interface UiBridgeOptions {
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
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
    if (content === undefined || Array.isArray(content)) {
      fire({
        method: "setWidget",
        widgetKey: key,
        widgetLines: content,
        ...(widgetOptions?.placement ? { widgetPlacement: widgetOptions.placement } : {}),
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
    custom: <T>() => Promise.resolve(undefined as T),
    pasteToEditor: (text) => fire({ method: "set_editor_text", text }),
    setEditorText: (text) => fire({ method: "set_editor_text", text }),
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: PLAIN_THEME,
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
    cancelAll: () => {
      for (const dialogHandle of [...pending.values()]) dialogHandle.close();
    },
    pendingCount: () => pending.size,
  };
}

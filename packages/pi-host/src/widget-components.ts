import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { UI_LIMITS } from "@pap/contracts";
import {
  createRenderTimer,
  disposeQuietly,
  headlessTui,
  type LiveComponent,
  watchRejection,
  type PanelDeps,
  REAL_TIMERS,
  PANEL_COLUMNS,
} from "./custom-panels.ts";
import { boundLines, UI_RECORD_BYTES } from "./ui-lines.ts";

export type WidgetFactory = (tui: TUI, theme: Theme) => LiveComponent;

export type WidgetRecord = {
  type: "extension_ui_request";
  id: string;
  method: "setWidget";
  widgetKey: string;
  widgetLines: string[] | undefined;
  widgetPlacement?: string;
};

export interface WidgetComponents {
  set(key: string, factory: WidgetFactory, placement?: string): void;
  /** Clears the key and tells the daemon; false when no component widget held it (nothing was sent). */
  clear(key: string): boolean;
  /** Disposes the key's component without telling the daemon, for a caller about to send its own record. */
  release(key: string): void;
  clearAll(): void;
}

interface Live {
  /** True while the daemon shows lines for this key that this component sent. */
  visible: boolean;
  dispose(): void;
}

/** Widgets whose content is a component: rendered at the panels' size, redrawn on `requestRender`, one per key. */
export function createWidgetComponents(
  send: (record: WidgetRecord) => boolean,
  deps: PanelDeps,
): WidgetComponents {
  const timers = deps.timers ?? REAL_TIMERS;
  const live = new Map<string, Live>();
  const trySend = (record: WidgetRecord): boolean => {
    try {
      return send(record);
    } catch {
      return false;
    }
  };
  const emit = (key: string, lines: string[] | undefined, placement: string | undefined) =>
    trySend({
      type: "extension_ui_request",
      id: deps.newId(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: lines,
      ...(placement ? { widgetPlacement: placement } : {}),
    });

  /** Disposes the component of a key; the lines it left on screen are the caller's to replace or clear. */
  function drop(key: string): Live | undefined {
    const previous = live.get(key);
    if (!previous) return undefined;
    live.delete(key);
    previous.dispose();
    return previous;
  }

  function set(key: string, factory: WidgetFactory, placement?: string): void {
    const handle: Live = {
      // A replacement that fails must clear what the one before it left on screen.
      visible: drop(key)?.visible ?? false,
      dispose: () => {
        closed = true;
        redraw.cancel();
        disposeQuietly(component, deps.onError);
        component = undefined;
      },
    };
    let component: LiveComponent | undefined;
    let closed = false;
    const redraw = createRenderTimer(timers, () => render());
    const fail = (error: unknown): void => {
      deps.onError("setWidget", error);
      // Disposed already (replaced, released, cleared, or failed before): what the key shows now is not this
      // component's, so it must not clear it (deferred #31).
      if (closed) return;
      if (live.get(key) === handle) live.delete(key);
      handle.dispose();
      if (handle.visible) emit(key, undefined, undefined);
      handle.visible = false;
    };
    function render(): void {
      if (closed || !component) return;
      redraw.cancel();
      try {
        const rendered: unknown = component.render(PANEL_COLUMNS);
        if (watchRejection(rendered, fail, () => fail(new TypeError("render() must not be async")))) return;
        if (!Array.isArray(rendered)) throw new TypeError("render() did not return an array of lines");
        const lines = boundLines(rendered, {
          lines: UI_LIMITS.widgetLines,
          lineChars: UI_LIMITS.widgetLineChars,
          bytes: UI_RECORD_BYTES,
        });
        handle.visible = true;
        emit(key, lines, placement);
      } catch (error) {
        fail(error);
      }
    }
    if (live.size >= UI_LIMITS.widgets) {
      fail(new Error(`too many widgets: at most ${UI_LIMITS.widgets}`));
      return;
    }
    try {
      component = factory(
        headlessTui(() => {
          if (!closed) redraw.request();
        }),
        deps.theme,
      );
    } catch (error) {
      fail(error);
      return;
    }
    live.set(key, handle);
    render();
  }

  return {
    set,
    clear: (key) => {
      const previous = drop(key);
      if (!previous) return false;
      emit(key, undefined, undefined);
      return true;
    },
    release: (key) => void drop(key),
    clearAll: () => {
      for (const key of [...live.keys()]) {
        drop(key);
        emit(key, undefined, undefined);
      }
    },
  };
}

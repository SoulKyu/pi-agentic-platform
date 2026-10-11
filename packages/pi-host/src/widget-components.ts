import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { UI_LIMITS } from "@pap/contracts";
import {
  createRenderTimer,
  disposeQuietly,
  headlessTui,
  type LiveComponent,
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
  clear(key: string): void;
  clearAll(): void;
}

interface Live {
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

  function drop(key: string): boolean {
    const previous = live.get(key);
    if (!previous) return false;
    live.delete(key);
    previous.dispose();
    return true;
  }

  function set(key: string, factory: WidgetFactory, placement?: string): void {
    drop(key);
    if (live.size >= UI_LIMITS.widgets) {
      deps.onError("setWidget", new Error(`too many widgets: at most ${UI_LIMITS.widgets}`));
      return;
    }
    let component: LiveComponent | undefined;
    let closed = false;
    const redraw = createRenderTimer(timers, () => render());
    const handle: Live = {
      dispose: () => {
        closed = true;
        redraw.cancel();
        disposeQuietly(component, deps.onError);
        component = undefined;
      },
    };
    function render(): boolean {
      if (closed || !component) return false;
      redraw.cancel();
      try {
        const rendered: unknown = component.render(PANEL_COLUMNS);
        if (!Array.isArray(rendered)) throw new TypeError("render() did not return an array of lines");
        const lines = boundLines(rendered, {
          lines: UI_LIMITS.widgetLines,
          lineChars: UI_LIMITS.widgetLineChars,
          bytes: UI_RECORD_BYTES,
        });
        emit(key, lines, placement);
        return true;
      } catch (error) {
        deps.onError("setWidget", error);
        live.delete(key);
        handle.dispose();
        return false;
      }
    }
    try {
      component = factory(
        headlessTui(() => {
          if (!closed) redraw.request();
        }),
        deps.theme,
      );
    } catch (error) {
      deps.onError("setWidget", error);
      return;
    }
    live.set(key, handle);
    render();
  }

  return {
    set,
    clear: (key) => {
      if (drop(key)) emit(key, undefined, undefined);
    },
    clearAll: () => {
      for (const key of [...live.keys()]) {
        drop(key);
        emit(key, undefined, undefined);
      }
    },
  };
}

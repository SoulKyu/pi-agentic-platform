import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { UI_LIMITS } from "@pap/contracts";
import { boundLines, UI_RECORD_BYTES } from "./ui-lines.ts";

/** Panels and widgets render at a fixed size (M2R77, S1): there is no resize protocol between browser and worker. */
export const PANEL_COLUMNS = 92;
export const PANEL_ROWS = 40;
/** A component asking for a redraw gets at most one render per this long, with the state it has then (M2R80). */
export const RENDER_EVERY_MS = 50;

export interface RenderTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Real timers; `unref`ed so a pending render never keeps the worker alive. */
export const REAL_TIMERS: RenderTimers = {
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type LiveComponent = Component & { dispose?(): void };

/** The `tui` extensions' components are given: a fixed-size terminal whose redraw requests are coalesced. */
export function headlessTui(requestRender: () => void): TUI {
  return {
    terminal: { columns: PANEL_COLUMNS, rows: PANEL_ROWS, kittyProtocolActive: false },
    requestRender,
  } as unknown as TUI;
}

/** At most one pending timer; `request` while one is pending changes nothing, so the latest state wins when it fires. */
export function createRenderTimer(timers: RenderTimers, fire: () => void) {
  let handle: unknown;
  let pending = false;
  const cancel = () => {
    if (!pending) return;
    pending = false;
    timers.clearTimer(handle);
  };
  return {
    request: () => {
      if (pending) return;
      pending = true;
      handle = timers.setTimer(() => {
        pending = false;
        fire();
      }, RENDER_EVERY_MS);
    },
    cancel,
  };
}

export type PanelOutbound =
  { type: "custom_render"; id: string; lines: string[] } | { type: "custom_close"; id: string };

/** The SDK exports its keybindings manager as a type only (S1): the type is read off the `custom` signature. */
type SdkKeybindings = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[2];

export type PanelFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: SdkKeybindings,
  done: (result: T) => void,
) => LiveComponent | Promise<LiveComponent>;

export interface PanelDeps {
  newId(): string;
  theme: Theme;
  onError(event: string, error: unknown): void;
  timers?: RenderTimers;
}

export interface CustomPanels {
  open<T>(factory: PanelFactory<T>): Promise<T>;
  input(id: string, data: string): void;
  cancel(id: string): void;
  cancelAll(): void;
  count(): number;
}

interface OpenPanel {
  input(data: string): void;
  cancel(): void;
}

/** Calls a component's `dispose`, reporting a throw instead of letting it out. */
export function disposeQuietly(component: LiveComponent | undefined, onError: PanelDeps["onError"]): void {
  try {
    component?.dispose?.();
  } catch (error) {
    onError("custom_dispose", error);
  }
}

export function createCustomPanels(send: (record: PanelOutbound) => boolean, deps: PanelDeps): CustomPanels {
  const timers = deps.timers ?? REAL_TIMERS;
  const panels = new Map<string, OpenPanel>();
  // pi-tui's manager answers `matches` and `getKeys` like the SDK's; the SDK adds config-file members panels do not use.
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as SdkKeybindings;
  const trySend = (record: PanelOutbound): boolean => {
    try {
      return send(record);
    } catch {
      // The daemon link is gone: nothing can show this panel any more, and the caller closes it.
      return false;
    }
  };

  function open<T>(factory: PanelFactory<T>): Promise<T> {
    if (panels.size >= UI_LIMITS.panels) {
      deps.onError("custom_open", new Error(`too many open panels: at most ${UI_LIMITS.panels}`));
      return Promise.resolve(undefined as T);
    }
    const id = deps.newId();
    return new Promise<T>((resolve) => {
      let closed = false;
      let component: LiveComponent | undefined;
      const redraw = createRenderTimer(timers, () => render());

      const done = (value: T | undefined): void => {
        if (closed) return;
        closed = true;
        panels.delete(id);
        redraw.cancel();
        disposeQuietly(component, deps.onError);
        component = undefined;
        trySend({ type: "custom_close", id });
        resolve(value as T);
      };
      function render(): void {
        if (closed || !component) return;
        redraw.cancel();
        let lines: string[];
        try {
          const rendered: unknown = component.render(PANEL_COLUMNS);
          if (!Array.isArray(rendered)) throw new TypeError("render() did not return an array of lines");
          lines = boundLines(rendered, {
            lines: UI_LIMITS.panelLines,
            lineChars: UI_LIMITS.panelLineChars,
            bytes: UI_RECORD_BYTES,
          });
        } catch (error) {
          deps.onError("custom_render", error);
          done(undefined);
          return;
        }
        if (!trySend({ type: "custom_render", id, lines })) done(undefined);
      }

      // Registered before the factory runs, so a cancel while an async factory is pending is seen.
      panels.set(id, {
        input: (data) => {
          if (closed || !component || data.length > UI_LIMITS.panelInput) return;
          try {
            component.handleInput?.(data);
          } catch (error) {
            deps.onError("custom_input", error);
            done(undefined);
            return;
          }
          render();
        },
        cancel: () => done(undefined),
      });
      // Through a promise, so a synchronous throw is caught like an asynchronous one.
      Promise.resolve()
        .then(() =>
          factory(
            headlessTui(() => {
              if (!closed) redraw.request();
            }),
            deps.theme,
            keybindings,
            done,
          ),
        )
        .then(
          (created) => {
            if (closed) {
              disposeQuietly(created, deps.onError);
              return;
            }
            component = created;
            render();
          },
          (error: unknown) => {
            deps.onError("custom_factory", error);
            done(undefined);
          },
        );
    });
  }

  return {
    open,
    input: (id, data) => panels.get(id)?.input(data),
    cancel: (id) => panels.get(id)?.cancel(),
    cancelAll: () => {
      for (const panel of [...panels.values()]) panel.cancel();
    },
    count: () => panels.size,
  };
}

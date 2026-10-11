import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { TooltipProvider } from "../primitives/Tooltip.tsx";

// React only batches updates inside act() when the environment says it is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  readonly container: HTMLElement;
  rerender(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

// Every mount not yet unmounted: a test that fails before its inline unmount() must not leak its registrations.
const live = new Set<() => Promise<void>>();

/** Unmounts what is still mounted. Runs after each test of any file that imports this module. */
export async function unmountAll(): Promise<void> {
  for (const unmount of [...live]) await unmount();
}
afterEach(unmountAll);

/** Renders into the happy-dom document, with effects and pending state updates settled. */
export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  const unmount = async () => {
    if (!live.delete(unmount)) return;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  live.add(unmount);
  return {
    container,
    rerender: async (next: ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount,
  };
}

/** `mount` inside the TooltipProvider that every IconButton needs; `rerender` keeps the provider. */
export async function mountWithTooltips(element: ReactElement): Promise<Mounted> {
  const wrap = (inner: ReactElement) => createElement(TooltipProvider, null, inner);
  const page = await mount(wrap(element));
  return { ...page, rerender: (next) => page.rerender(wrap(next)) };
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Presses a key on an element and says whether the page left it to the browser (`defaultPrevented` is false). */
export async function press(element: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

/** The button whose text is exactly `name`; throws when there is none, so a missing answer fails loudly. */
export function button(container: ParentNode, name: string): HTMLElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
}

/** Runs one macrotask inside act(): Radix FocusScope returns focus from a setTimeout(0) after a layer unmounts. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

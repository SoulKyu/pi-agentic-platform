import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

export { flush } from "../runtime/testing.ts";

// React only batches updates inside act() when the environment says it is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  readonly container: HTMLElement;
  rerender(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

/** Renders into the happy-dom document, with effects and pending state updates settled. */
export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    rerender: async (next: ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Lets the promises a handler started settle, then React's updates from them. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

export async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setValue) throw new Error("no value setter on the field");
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
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

const words = (element: Element): string => (element.textContent ?? "").trim();

/** The button with this exact visible text; throws when there is none or several (an e2e would too). */
export function button(container: ParentNode, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].filter((candidate) => words(candidate) === name);
  if (found.length !== 1) throw new Error(`expected one button "${name}", found ${found.length}`);
  return found[0] as HTMLButtonElement;
}

export function hasButton(container: ParentNode, name: string): boolean {
  return [...container.querySelectorAll("button")].some((candidate) => words(candidate) === name);
}

/** The input or textarea a `<label>` with this exact text points at. */
export function field(container: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...container.querySelectorAll("label")].filter((candidate) => words(candidate) === label);
  const target = found.length === 1 ? document.getElementById(found[0]?.htmlFor ?? "") : null;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    throw new Error(`expected one field labelled "${label}", found ${found.length}`);
  }
  return target;
}

export function alerts(container: ParentNode): string[] {
  return [...container.querySelectorAll('[role="alert"]')].map(words);
}

export function text(container: ParentNode): string {
  return words(container as Element);
}

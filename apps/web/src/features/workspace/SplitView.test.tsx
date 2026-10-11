// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, press } from "../../testing/dom.ts";
import { SplitView } from "./SplitView.tsx";

const measured = vi.hoisted(() => ({ width: 1000 }));
vi.mock("./use-element-width.ts", () => ({ useElementWidth: () => measured.width }));

afterEach(() => {
  measured.width = 1000;
});

const view = (onRatio: (ratio: number) => void, ratio = 0.5) => (
  <SplitView
    ratio={ratio}
    onRatio={onRatio}
    label="Resize panes"
    first={<p data-test="first">one</p>}
    second={<p data-test="second">two</p>}
  />
);

describe("SplitView", () => {
  it("exposes a keyboard-operable separator with its bounds and value", async () => {
    const onRatio = vi.fn();
    const page = await mount(view(onRatio));
    const separator = page.container.querySelector('[role="separator"]') as HTMLElement;
    expect(
      ["aria-orientation", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-label", "tabindex"].map(
        (name) => separator.getAttribute(name),
      ),
    ).toEqual(["vertical", "32", "68", "50", "Resize panes", "0"]);
    const event = await press(separator, { key: "ArrowLeft" });
    expect(event.defaultPrevented).toBe(true);
    expect(onRatio).toHaveBeenCalledExactlyOnceWith(0.492);
    const other = await press(separator, { key: "Enter" });
    expect(other.defaultPrevented).toBe(false);
    expect(onRatio).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("renders only the first pane below two minimum widths", async () => {
    measured.width = 600;
    const page = await mount(view(vi.fn()));
    expect(page.container.querySelector('[data-test="first"]')).not.toBeNull();
    expect(page.container.querySelector('[data-test="second"]')).toBeNull();
    expect(page.container.querySelector('[role="separator"]')).toBeNull();
    await page.unmount();
  });

  it("drags without a store write per move and commits once on release", async () => {
    const onRatio = vi.fn();
    const page = await mount(view(onRatio));
    const separator = page.container.querySelector('[role="separator"]') as HTMLElement;
    const first = page.container.querySelector('[data-test="first"]')?.parentElement as HTMLElement;
    const container = first.parentElement as HTMLElement;
    container.getBoundingClientRect = () => ({ left: 100, width: 1000 }) as DOMRect;
    const captured: number[] = [];
    separator.setPointerCapture = (id: number) => void captured.push(id);
    separator.hasPointerCapture = () => true;
    separator.releasePointerCapture = () => {};
    const fire = (type: string, init: PointerEventInit & { clientX?: number }) =>
      separator.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
    fire("pointerdown", { pointerId: 1, clientX: 600 });
    fire("pointerdown", { pointerId: 2, clientX: 900 });
    fire("pointermove", { pointerId: 1, clientX: 400 });
    expect(first.style.flexBasis).toBe("32%");
    fire("pointermove", { pointerId: 1, clientX: 700 });
    expect(first.style.flexBasis).toBe("60%");
    expect(onRatio).not.toHaveBeenCalled();
    fire("pointerup", { pointerId: 1, clientX: 700 });
    fire("lostpointercapture", { pointerId: 1 });
    expect(captured).toEqual([1]);
    expect(onRatio).toHaveBeenCalledExactlyOnceWith(0.6);
    await page.unmount();
  });
});

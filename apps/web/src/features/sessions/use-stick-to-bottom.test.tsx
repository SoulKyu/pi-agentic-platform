// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../testing/dom.ts";
import { scrollAfterPrepend, stickDecision, useStickToBottom } from "./use-stick-to-bottom.ts";

describe("scroll decisions", () => {
  it("counts the reader as at the bottom within a few pixels", () => {
    expect(stickDecision({ scrollTop: 953, scrollHeight: 1500, clientHeight: 500 })).toBe(true);
    expect(stickDecision({ scrollTop: 900, scrollHeight: 1500, clientHeight: 500 })).toBe(false);
  });
  it("moves by exactly the height that landed above", () => {
    expect(scrollAfterPrepend({ top: 120, height: 1000 }, 1650)).toBe(770);
    expect(scrollAfterPrepend({ top: 0, height: 1000 }, 1000)).toBe(0);
  });
});

/** Stands in for layout, which happy-dom does not have: the numbers a browser would measure. */
interface Layout {
  top: number;
  height: number;
  client: number;
}
let page: Mounted | null = null;
let api: { preserveOnPrepend: () => () => void };
let bump: () => void = () => {};
afterEach(async () => {
  await page?.unmount();
  page = null;
});

function Probe() {
  const [change, setChange] = useState(0);
  const { attach, onScroll, preserveOnPrepend } = useStickToBottom(change);
  useEffect(() => {
    bump = () => setChange((n) => n + 1);
    api = { preserveOnPrepend };
  });
  return <ol ref={attach} onScroll={onScroll} />;
}
async function setup(layout: Layout) {
  page = await mount(<Probe />);
  const list = page.container.querySelector("ol") as HTMLElement;
  Object.defineProperty(list, "scrollTop", {
    get: () => layout.top,
    set: (value: number) => (layout.top = value),
    configurable: true,
  });
  Object.defineProperty(list, "scrollHeight", { get: () => layout.height, configurable: true });
  Object.defineProperty(list, "clientHeight", { get: () => layout.client, configurable: true });
  return list;
}
const grow = async (layout: Layout, height: number) => {
  layout.height = height;
  await act(async () => bump());
};
const scrollTo = async (list: HTMLElement, layout: Layout, top: number) => {
  layout.top = top;
  await act(async () => {
    list.dispatchEvent(new Event("scroll"));
  });
};

describe("useStickToBottom", () => {
  it("follows the end while the reader is at the bottom", async () => {
    const layout = { top: 0, height: 500, client: 500 };
    await setup(layout);
    await grow(layout, 900);
    expect(layout.top).toBe(900);
  });

  it("leaves a reader who scrolled up where they are", async () => {
    const layout = { top: 0, height: 2000, client: 500 };
    const list = await setup(layout);
    await scrollTo(list, layout, 300);
    await grow(layout, 2400);
    expect(layout.top).toBe(300);
  });

  it("follows again once the reader is back at the bottom", async () => {
    const layout = { top: 0, height: 2000, client: 500 };
    const list = await setup(layout);
    await scrollTo(list, layout, 300);
    await scrollTo(list, layout, 1500);
    await grow(layout, 2400);
    expect(layout.top).toBe(2400);
  });

  it("keeps the reader on the same row when older rows land above", async () => {
    const layout = { top: 0, height: 2000, client: 500 };
    const list = await setup(layout);
    await scrollTo(list, layout, 40);
    api.preserveOnPrepend();
    await grow(layout, 2650);
    expect(layout.top).toBe(690);
  });

  it("does not stick to the bottom after a prepend, even for a reader who was at the bottom of a short list", async () => {
    const layout = { top: 0, height: 500, client: 500 };
    await setup(layout);
    api.preserveOnPrepend();
    await grow(layout, 1100);
    expect(layout.top).toBe(600);
  });

  it("applies the prepend once: the next growth is judged by where the reader is", async () => {
    const layout = { top: 0, height: 2000, client: 500 };
    const list = await setup(layout);
    await scrollTo(list, layout, 40);
    api.preserveOnPrepend();
    await grow(layout, 2650);
    await scrollTo(list, layout, layout.top);
    await grow(layout, 2700);
    expect(layout.top).toBe(690);
  });

  it("forgets a prepend whose page was dropped, so later growth does not shift the reader", async () => {
    const layout = { top: 0, height: 2000, client: 500 };
    const list = await setup(layout);
    await scrollTo(list, layout, 40);
    const release = api.preserveOnPrepend();
    release();
    await grow(layout, 2200);
    expect(layout.top).toBe(40);
  });
});

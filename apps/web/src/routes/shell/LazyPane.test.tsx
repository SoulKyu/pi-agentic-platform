// @vitest-environment happy-dom
import { Toaster } from "@pap/ui";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { LazyPane } from "./LazyPane.tsx";

const Screen = ({ name }: { readonly name: string }) => createElement("p", { "data-screen": name }, name);
const toasts = () =>
  [...document.querySelectorAll("button")].filter((one) => one.textContent === "Reload").length;

async function show(load: () => Promise<{ default: typeof Screen }>) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return mount(
    <>
      <LazyPane load={load} props={{ name: "ok" }} />
      <Toaster closeLabel="Dismiss" />
    </>,
  );
}

describe("LazyPane", () => {
  it("imports once on a failure, says so once, and offers Retry instead of looping", async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new Error("Failed to fetch dynamically imported module: chunk.js"));
    const page = await show(load);
    await settle();
    await settle();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(toasts()).toBe(1);
    expect(page.container.querySelector("h2")?.textContent).toBe("This screen did not load");
    expect(button(page.container, "Retry")).not.toBeNull();
    await page.unmount();
  });

  it("imports once more on Retry, and renders the screen when that works", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module: chunk.js"))
      .mockResolvedValueOnce({ default: Screen });
    const page = await show(load);
    await settle();
    await click(button(page.container, "Retry"));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(page.container.querySelector('[data-screen="ok"]')).not.toBeNull();
    expect(page.container.querySelector("h2")).toBeNull();
    await page.unmount();
  });

  it("fails again on a failing Retry: one more import and one more toast, still no loop", async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new Error("Failed to fetch dynamically imported module: chunk.js"));
    const page = await show(load);
    await settle();
    await click(button(page.container, "Retry"));
    await settle();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(page.container.querySelector("h2")?.textContent).toBe("This screen did not load");
    await page.unmount();
  });
});

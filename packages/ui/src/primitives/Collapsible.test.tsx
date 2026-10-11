// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { Collapsible } from "./Collapsible.tsx";

describe("Collapsible (ADR 0010)", () => {
  it("a click on the trigger asks for the opposite state and shows it when uncontrolled by the parent", async () => {
    const onOpenChange = vi.fn();
    const page = await mount(
      <Collapsible open={false} onOpenChange={onOpenChange} trigger="Thought for 14s">
        <p>Reasoning body</p>
      </Collapsible>,
    );
    const trigger = page.container.querySelector("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await click(trigger);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    await page.unmount();
  });

  it("respects the controlled open state: expanded content shows and the next click asks to close", async () => {
    const onOpenChange = vi.fn();
    const page = await mount(
      <Collapsible open onOpenChange={onOpenChange} trigger="Tool call">
        <p>Details</p>
      </Collapsible>,
    );
    const trigger = page.container.querySelector("button") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(page.container.textContent).toContain("Details");
    await click(trigger);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await page.unmount();
  });
});

// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, press, settle } from "../testing/dom.ts";
import { Select } from "./Select.tsx";

const OPTIONS = Array.from({ length: 300 }, (_, index) => ({
  value: `m${String(index + 1)}`,
  label: `Model ${String(index + 1)}`,
}));

function stubLayoutApis() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}

function Harness({ onChange }: { readonly onChange: (value: string) => void }) {
  const [value, setValue] = useState("m1");
  return (
    <Select
      label="Model"
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

async function openSelect(onChange: (value: string) => void) {
  stubLayoutApis();
  const page = await mount(<Harness onChange={onChange} />);
  const trigger = page.container.querySelector('[role="combobox"]') as HTMLElement;
  await press(trigger, { key: "Enter" });
  await settle(); // Radix places the list (floating-ui resolves) before it takes keys
  const content = document.querySelector('[role="listbox"]') as HTMLElement;
  return { page, content };
}

// The browser sends keys to the focused option; they bubble to the listbox. Radix moves focus in a setTimeout(0).
async function key(init: KeyboardEventInit): Promise<void> {
  await press(document.activeElement as Element, init);
  await settle();
}
const highlighted = () => document.querySelector("[data-highlighted]")?.textContent;

describe("Select error", () => {
  it("an error sets aria-invalid and describes the trigger", async () => {
    const page = await mount(
      <Select
        label="Model"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onChange={() => {}}
        error="Pick one"
      />,
    );
    const trigger = page.container.querySelector('[role="combobox"]') as HTMLElement;
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    const alert = page.container.querySelector('[data-slot="inline-error"]') as HTMLElement;
    expect(alert.textContent).toBe("Pick one");
    expect(alert.className).toContain("text-err");
    expect(trigger.getAttribute("aria-describedby")).toContain(alert.id);
    await page.unmount();
  });
});

describe("Select with a long list", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is bounded and its viewport is marked for the scrollbar rule", async () => {
    const { page, content } = await openSelect(() => {});
    expect(content.className.split(/\s+/)).toContain("max-h-available");
    expect(content.className.split(/\s+/)).toContain("overflow-hidden");
    expect(
      document.querySelector('[data-radix-select-viewport][data-slot="select-viewport"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(300);
    await page.unmount();
  });

  it("End highlights the last option and Home the first", async () => {
    const { page } = await openSelect(() => {});
    await key({ key: "End" });
    expect(highlighted()).toBe("Model 300");
    await key({ key: "Home" });
    expect(highlighted()).toBe("Model 1");
    await page.unmount();
  });

  it("typing jumps by typeahead", async () => {
    const { page } = await openSelect(() => {});
    for (const char of "Model 25") await key({ key: char });
    expect(highlighted()).toBe("Model 25");
    await page.unmount();
  });

  it("choosing the 250th option reports its value", async () => {
    const onChange = vi.fn();
    const { page } = await openSelect(onChange);
    for (const char of "Model 250") await key({ key: char });
    expect(highlighted()).toBe("Model 250");
    await key({ key: "Enter" });
    await act(async () => {});
    expect(onChange).toHaveBeenCalledExactlyOnceWith("m250");
    await page.unmount();
  });
});

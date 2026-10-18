// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { cancelsComposition } from "./composition.ts";
import { Checkbox } from "./Checkbox.tsx";
import { Segmented } from "./Segmented.tsx";
import { Select } from "./Select.tsx";
import { Slider } from "./Slider.tsx";
import { Switch } from "./Switch.tsx";

const DENSITY = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
] as const;

describe("cancelsComposition", () => {
  it("is true while composing and for Safari's keyCode 229", () => {
    expect([
      cancelsComposition({ isComposing: true }),
      cancelsComposition({ keyCode: 229 }),
      cancelsComposition({ keyCode: 27 }),
    ]).toEqual([true, true, false]);
  });
});

describe("form controls", () => {
  it("Switch is a labelled square switch that reports the new state", async () => {
    const onChange = vi.fn();
    const page = await mount(<Switch label="Background grid" checked={false} onChange={onChange} />);
    const control = page.container.querySelector('[role="switch"]') as HTMLElement;
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-labelledby")).toBeTruthy();
    await click(control);
    expect(onChange).toHaveBeenCalledWith(true);
    await page.unmount();
  });

  it("Switch toggles when its label text is pressed (m3)", async () => {
    const onChange = vi.fn();
    const page = await mount(<Switch label="Background grid" checked={false} onChange={onChange} />);
    await click(page.container.querySelector("label") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(true);
    await page.unmount();
  });

  it("Checkbox: the whole row is one label, so its 44 px area is the click target (N4)", async () => {
    const onChange = vi.fn();
    const page = await mount(<Checkbox label="Seen" checked={false} onChange={onChange} />);
    const row = page.container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    expect(row.tagName).toBe("LABEL");
    await click(row.querySelector("span") as HTMLElement); // the text
    expect(onChange).toHaveBeenCalledWith(true);
    await page.unmount();
  });

  it("inside a form, the hidden input Radix adds is contained by the control's own row, not by the page", async () => {
    const page = await mount(
      <form>
        <Switch label="Grid" checked={false} onChange={vi.fn()} />
        <Checkbox label="Seen" checked={false} onChange={vi.fn()} />
        <Select label="Density" value="compact" options={DENSITY} onChange={vi.fn()} />
      </form>,
    );
    const hidden = [...page.container.querySelectorAll<HTMLElement>('input[type="checkbox"], select')];
    expect(hidden).toHaveLength(3);
    for (const input of hidden) {
      // Radix positions it `absolute`: with no positioned ancestor it escapes a clipping scroller and the document scrolls.
      expect(input.style.position).toBe("absolute");
      expect(input.parentElement?.className.split(" ")).toContain("relative");
    }
    await page.unmount();
  });

  it("Checkbox reports the new state", async () => {
    const onChange = vi.fn();
    const page = await mount(<Checkbox label="Seen" checked onChange={onChange} />);
    await click(page.container.querySelector('[role="checkbox"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(false);
    await page.unmount();
  });

  it("Segmented selects one value and never none", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <Segmented label="Density" value="compact" options={DENSITY} onChange={onChange} />,
    );
    const items = [...page.container.querySelectorAll('[role="radio"]')] as HTMLElement[];
    expect(items.map((item) => item.textContent)).toEqual(["Compact", "Comfortable"]);
    await click(items[1] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("comfortable");
    await click(items[0] as HTMLElement);
    expect(onChange).not.toHaveBeenCalledWith("");
    await page.unmount();
  });

  it("Select shows the chosen option and is labelled", async () => {
    const page = await mount(
      <Select label="Density" value="comfortable" options={DENSITY} onChange={() => {}} />,
    );
    const trigger = page.container.querySelector('[role="combobox"]') as HTMLElement;
    expect(trigger.textContent).toContain("Comfortable");
    const labelId = trigger.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelId.split(" ")[0] ?? "")?.textContent).toBe("Density");
    await page.unmount();
  });

  it("Slider exposes a value text", async () => {
    const page = await mount(
      <Slider
        label="Chat size"
        value={14}
        min={13}
        max={18}
        onChange={() => {}}
        valueText={(v) => `${v} px`}
      />,
    );
    expect(page.container.querySelector('[role="slider"]')?.getAttribute("aria-valuetext")).toBe("14 px");
    await page.unmount();
  });
});

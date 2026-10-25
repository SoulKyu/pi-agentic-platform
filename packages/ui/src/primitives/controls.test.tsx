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

  it("Segmented shows its label and names the radiogroup by it; labelHidden keeps it for screen readers only", async () => {
    const page = await mount(
      <>
        <Segmented label="Density" value="compact" options={DENSITY} onChange={vi.fn()} />
        <Segmented label="Hidden" labelHidden value="compact" options={DENSITY} onChange={vi.fn()} />
      </>,
    );
    const groups = [...page.container.querySelectorAll('[role="group"], [role="radiogroup"]')];
    const [shown, hidden] = groups.map((group) => {
      const label = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
      return label;
    });
    expect(shown?.textContent).toBe("Density");
    expect(shown?.className).toContain("label-hud");
    expect(shown?.className).not.toContain("sr-only");
    expect(hidden?.textContent).toBe("Hidden");
    expect(hidden?.className).toContain("sr-only");
    await page.unmount();
  });

  it("Switch hit area measures 44 x 44 px under a coarse pointer", async () => {
    const page = await mount(<Switch label="Grid" checked={false} onChange={vi.fn()} />);
    const classes = (page.container.querySelector('[role="switch"]') as HTMLElement).className.split(" ");
    const px = (utility: string) => {
      const match = /^pointer-coarse:before:-inset-[xy]-(\d+(?:\.\d+)?)$/.exec(utility);
      return Number(match?.[1]) * 4; // Tailwind spacing: 0.25rem per unit, 16 px root
    };
    const insetX = px(classes.find((c) => c.startsWith("pointer-coarse:before:-inset-x-")) ?? "");
    const insetY = px(classes.find((c) => c.startsWith("pointer-coarse:before:-inset-y-")) ?? "");
    const TRACK = { width: 32, height: 16 }; // h-4 w-8
    const BORDER = 1; // the before: box is placed against the padding box, inside the border
    expect(classes).toContain("h-4");
    expect(classes).toContain("w-8");
    expect(TRACK.width - 2 * BORDER + 2 * insetX).toBe(44);
    expect(TRACK.height - 2 * BORDER + 2 * insetY).toBe(44);
    await page.unmount();
  });

  it("the Switch row is at least 44 px under a coarse pointer, so rows stacked 4 px apart cannot overlap boxes", async () => {
    const page = await mount(<Switch label="Grid" checked={false} onChange={vi.fn()} />);
    const row = page.container.querySelector('[data-slot="switch"]') as HTMLElement;
    expect(row.className.split(" ")).toContain("pointer-coarse:min-h-11"); // min-h-11 = 2.75rem = 44 px
    await page.unmount();
  });

  it("Switch meta sits between the label and the track", async () => {
    const page = await mount(
      <Switch label="Grid" meta={<span data-testid="meta">3 on</span>} checked={false} onChange={vi.fn()} />,
    );
    const row = page.container.querySelector('[data-slot="switch"]') as HTMLElement;
    const kids = [...row.children];
    expect(kids).toHaveLength(3);
    expect(kids[1]?.textContent).toBe("3 on");
    expect(kids[2]?.getAttribute("role")).toBe("switch");
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

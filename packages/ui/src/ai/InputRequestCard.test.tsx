// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, mount, press, typeInto } from "../testing/dom.ts";
import { InputRequestCard } from "../extensions.ts";

const COMMON = {
  sourceLabel: "from an extension",
  detailsLabel: "Details",
  title: "Pick one",
  answered: false,
} as const;

describe("InputRequestCard", () => {
  it("is a plain group named by its title, labelled with its source, and an inline edit for Escape", async () => {
    const page = await mount(
      <InputRequestCard
        {...COMMON}
        kind="select"
        options={["a", "b"]}
        cancelLabel="Cancel"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    const group = page.container.querySelector('[role="group"]');
    expect(group?.hasAttribute("data-inline-edit")).toBe(true);
    expect(group?.getAttribute("aria-labelledby")).toBe(page.container.querySelector("h3")?.id);
    expect(page.container.querySelector("h3")?.textContent).toBe("Pick one");
    expect(page.container.querySelector("[data-extension-label]")?.textContent).toBe("from an extension");
    expect(page.container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("select: one button per option by position, then Cancel; all disabled once answered", async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const props = {
      ...COMMON,
      kind: "select",
      options: ["a", "a"],
      cancelLabel: "Cancel",
      onSelect,
      onCancel,
    } as const;
    const page = await mount(<InputRequestCard {...props} />);
    const buttons = [...page.container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["a", "a", "Cancel"]);
    await click(buttons[1] as HTMLElement);
    await click(button(page.container, "Cancel"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await page.rerender(<InputRequestCard {...props} answered />);
    expect([...page.container.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("confirm: Yes and No", async () => {
    const onConfirm = vi.fn();
    const page = await mount(
      <InputRequestCard {...COMMON} kind="confirm" yesLabel="Yes" noLabel="No" onConfirm={onConfirm} />,
    );
    await click(button(page.container, "Yes"));
    await click(button(page.container, "No"));
    expect(onConfirm.mock.calls).toEqual([[true], [false]]);
  });

  it("text: the title labels the field, Enter in a one-line field submits, composition does not", async () => {
    const onSubmit = vi.fn();
    const page = await mount(
      <InputRequestCard
        {...COMMON}
        title="Your name"
        kind="text"
        initialValue="Ada"
        placeholder="name"
        submitLabel="Submit"
        cancelLabel="Cancel"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    expect(page.container.querySelector("h3")).toBeNull();
    const input = page.container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("Ada");
    expect(input.placeholder).toBe("name");
    expect(page.container.querySelector("label")?.textContent).toBe("Your name");
    await press(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    await press(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Ada");
  });

  it("shows the message as a scrollable region only when the caller says it is expanded, and the timeout line", async () => {
    const page = await mount(
      <InputRequestCard
        {...COMMON}
        kind="confirm"
        yesLabel="Yes"
        noLabel="No"
        onConfirm={() => {}}
        message="Body"
        messageExpanded
        messageControl={<button type="button">Show less</button>}
        timeoutLine="Closes on its own after 5 s"
      />,
    );
    const region = page.container.querySelector("[data-clipped]");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-label")).toBe("Details");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(page.container.textContent).toContain("Show less");
    expect(page.container.textContent).toContain("Closes on its own after 5 s");
  });

  it("makes an expanded title a named, focusable region", async () => {
    const props = { ...COMMON, kind: "confirm", yesLabel: "Y", noLabel: "N", onConfirm: () => {} } as const;
    const page = await mount(<InputRequestCard {...props} />);
    expect(page.container.querySelector("[data-title-scroll]")?.hasAttribute("tabindex")).toBe(false);
    await page.rerender(<InputRequestCard {...props} titleExpanded />);
    const region = page.container.querySelector("[data-title-scroll]");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.getAttribute("aria-labelledby")).toBe(page.container.querySelector("h3")?.id);
  });

  it("text, multiline: Enter types a line, Ctrl+Enter submits the text", async () => {
    const onSubmit = vi.fn();
    const page = await mount(
      <InputRequestCard
        {...COMMON}
        kind="text"
        multiline
        initialValue="a"
        submitLabel="Submit"
        cancelLabel="Cancel"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    await typeInto(area, "line one\nline two");
    const enter = await press(area, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    const submit = await press(area, { key: "Enter", ctrlKey: true });
    expect(submit.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("line one\nline two");
  });
});

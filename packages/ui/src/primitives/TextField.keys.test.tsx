// @vitest-environment happy-dom
import { act, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { TextField } from "./TextField.tsx";

const noop = () => {};

async function press(element: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

describe("TextField passthrough props (M8R83)", () => {
  it("runs onKeyDown first and skips the submit shortcut when it prevented the event", async () => {
    const submit = vi.fn();
    const prevent = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    const page = await mount(
      <TextField
        label="M"
        value=""
        multiline
        onChange={noop}
        onSubmitShortcut={submit}
        onKeyDown={prevent}
      />,
    );
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    await press(area, { key: "Enter", ctrlKey: true });
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("still submits when onKeyDown leaves the event alone, and never during a composition", async () => {
    const submit = vi.fn();
    const page = await mount(
      <TextField label="M" value="" multiline onChange={noop} onSubmitShortcut={submit} onKeyDown={noop} />,
    );
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    await press(area, { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledTimes(1);
    await press(area, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("sets the combobox ARIA attributes", async () => {
    const page = await mount(
      <TextField
        label="M"
        value=""
        multiline
        onChange={noop}
        combobox={{ expanded: true, controls: "list-1", activeDescendant: "opt-2" }}
      />,
    );
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.getAttribute("role")).toBe("combobox");
    expect(area.getAttribute("aria-expanded")).toBe("true");
    expect(area.getAttribute("aria-controls")).toBe("list-1");
    expect(area.getAttribute("aria-activedescendant")).toBe("opt-2");
    expect(area.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("has no combobox role without the prop, and no active descendant when null", async () => {
    const plain = await mount(<TextField label="M" value="" multiline onChange={noop} />);
    expect(plain.container.querySelector("textarea")?.getAttribute("role")).toBeNull();
    const closed = await mount(
      <TextField
        label="M"
        value=""
        multiline
        onChange={noop}
        combobox={{ expanded: false, controls: "list-1", activeDescendant: null }}
      />,
    );
    const area = closed.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.getAttribute("aria-expanded")).toBe("false");
    expect(area.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("hands the textarea to inputRef and forwards paste, drop and dragover", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    const seen: string[] = [];
    const page = await mount(
      <TextField
        label="M"
        value=""
        multiline
        onChange={noop}
        inputRef={ref}
        onPaste={() => seen.push("paste")}
        onDrop={() => seen.push("drop")}
        onDragOver={() => seen.push("dragover")}
      />,
    );
    const area = page.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ref.current).toBe(area);
    await act(async () => {
      for (const type of ["paste", "drop", "dragover"])
        area.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    });
    expect(seen).toEqual(["paste", "drop", "dragover"]);
  });
});

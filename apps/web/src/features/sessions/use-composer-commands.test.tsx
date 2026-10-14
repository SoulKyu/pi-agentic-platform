// @vitest-environment happy-dom
import { TextField } from "@pap/ui";
import { act, useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { click, field, mount, press, settle, typeInto } from "../../testing/dom.ts";
import { overlayIsOpen } from "../../testing/context.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useComposerFieldProps } from "./composer/menus.ts";
import { useComposerCommands } from "./use-composer-commands.ts";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  navigate: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => current.navigate }));

// The menu is a lazy chunk: its first transform is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("./CommandMenu.tsx");
}, 60_000);

const none = { onPaste: () => {}, onDrop: () => {}, onDragOver: () => {} };
let latest: ReturnType<typeof useComposerCommands> | null = null;
const submitted = vi.fn();

function Probe({ initial = "" }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const commands = useComposerCommands({ sessionId: "s1", text, setText });
  useEffect(() => {
    latest = commands;
  });
  return (
    <>
      {commands.menu}
      <TextField
        label="Message"
        multiline
        value={text}
        onChange={setText}
        onSubmitShortcut={submitted}
        {...useComposerFieldProps([commands], none)}
      />
    </>
  );
}

const listing = {
  commands: [
    { name: "review", description: "Review the diff", source: "prompt", builtinMcp: false },
    { name: "mcp", description: "MCP servers", source: "extension", builtinMcp: true },
    { name: "skill:pdf", description: "Read PDFs", source: "skill", builtinMcp: false },
    { name: "skill:docx", description: null, source: "skill", builtinMcp: false },
  ],
  truncated: false,
};

function setup(answer: unknown = listing) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  current.navigate = vi.fn(() => Promise.resolve());
  submitted.mockClear();
  bed.handlers["sessions.commands"] = () => answer;
  return bed;
}
const rows = (container: ParentNode) =>
  [...container.querySelectorAll('[role="option"]')].map((node) => node.querySelector("span")?.textContent);
// The menu is a lazy chunk: the first import is slow, so waits are generous.
const shown = (container: ParentNode) =>
  act(async () => {
    await vi.waitFor(() => expect(rows(container).length).toBeGreaterThan(0), { timeout: 10_000 });
  });

describe("useComposerCommands", () => {
  it("asks for the commands only when a trigger first appears, once", async () => {
    const bed = setup();
    const page = await mount(<Probe />);
    await settle();
    expect(bed.called("sessions.commands")).toEqual([]);
    await typeInto(field(page.container, "Message"), "/");
    await shown(page.container);
    await typeInto(field(page.container, "Message"), "/r");
    await settle();
    expect(bed.called("sessions.commands").map((call) => call.params)).toEqual([{ sessionId: "s1" }]);
  });

  it("opens on /re with the caret at 3 and sets the combobox", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/re");
    await shown(page.container);
    expect(rows(page.container)).toEqual(["/review"]);
    expect(latest?.open).toBe(true);
    expect(latest?.combobox?.expanded).toBe(true);
    expect(area.getAttribute("role")).toBe("combobox");
    const listbox = page.container.querySelector('[role="listbox"]');
    expect(area.getAttribute("aria-controls")).toBe(listbox?.id);
    expect(overlayIsOpen()).toBe(true);
  });

  it("moves the active descendant with ArrowDown and ArrowUp", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/");
    await shown(page.container);
    const options = () => [...page.container.querySelectorAll('[role="option"]')];
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(area.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    const down = await press(area, { key: "ArrowDown" });
    expect(down.defaultPrevented).toBe(true);
    expect(area.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    await press(area, { key: "ArrowUp" });
    await press(area, { key: "ArrowUp" });
    expect(area.getAttribute("aria-activedescendant")).toBe(options().at(-1)?.id);
  });

  it("picks the row on Enter and never submits", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/rev");
    await shown(page.container);
    const enter = await press(area, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(area.value).toBe("/review ");
    expect(submitted).not.toHaveBeenCalled();
    expect(rows(page.container)).toEqual([]);
    expect(latest?.open).toBe(false);
    expect(area.getAttribute("aria-expanded")).toBeNull();
  });

  it("also picks on Tab, and a press on a row picks it", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/rev");
    await shown(page.container);
    const tab = await press(area, { key: "Tab" });
    expect(tab.defaultPrevented).toBe(true);
    expect(area.value).toBe("/review ");
    await typeInto(area, "/skill:d");
    await shown(page.container);
    const option = page.container.querySelector('[role="option"]');
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(area.value).toBe("/skill:docx ");
  });

  it("lets Mod+Enter submit while the menu is closed", async () => {
    setup();
    const page = await mount(<Probe initial="hello" />);
    const area = field(page.container, "Message");
    const enter = await press(area, { key: "Enter", ctrlKey: true });
    expect(enter.defaultPrevented).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(latest?.open).toBe(false);
  });

  it("closes on Escape, keeps the text, and an open menu is an overlay for the key dispatcher", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/re");
    await shown(page.container);
    expect(overlayIsOpen()).toBe(true);
    const escape = await press(area, { key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(area.value).toBe("/re");
    expect(rows(page.container)).toEqual([]);
    expect(overlayIsOpen()).toBe(false);
    expect(latest?.open).toBe(false);
  });

  it("does nothing on keys while closed", async () => {
    setup();
    const page = await mount(<Probe initial="plain text" />);
    const area = field(page.container, "Message");
    for (const key of ["ArrowDown", "Enter", "Tab", "Escape"]) {
      const event = await press(area, { key });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(area.value).toBe("plain text");
  });

  it("ignores keys itself while closed, without the join", async () => {
    setup();
    await mount(<Probe initial="plain text" />);
    const preventDefault = vi.fn();
    latest?.onKeyDown({ key: "ArrowDown", preventDefault, stopPropagation: vi.fn() } as never);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("says when the worker cut the list", async () => {
    setup({ ...listing, truncated: true });
    const page = await mount(<Probe />);
    await typeInto(field(page.container, "Message"), "/re");
    await shown(page.container);
    expect(page.container.textContent).toContain("The list is cut.");
  });

  it("puts a picked skill first in the text, shows the chip, and × takes it off", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "please $pd");
    await shown(page.container);
    expect(rows(page.container)).toEqual(["$pdf"]);
    await press(area, { key: "Enter" });
    expect(area.value).toBe("/skill:pdf please ");
    const chip = page.container.querySelector("[data-skill-chip]");
    expect(chip?.textContent).toContain("$pdf");
    const remove = chip?.querySelector("button") as HTMLButtonElement;
    expect(remove.getAttribute("aria-label")).toBe("Remove the skill pdf");
    await click(remove);
    expect(area.value).toBe("please ");
    expect(page.container.querySelector("[data-skill-chip]")).toBeNull();
  });

  it("opens Settings > MCP on Enter over the built-in /mcp and clears the field", async () => {
    setup();
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/mc");
    await shown(page.container);
    await press(area, { key: "Enter" });
    expect(current.navigate).toHaveBeenCalledWith({ to: "/settings/$section", params: { section: "mcp" } });
    expect(area.value).toBe("");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("completes a third-party /mcp instead of intercepting it", async () => {
    setup({
      commands: [{ name: "mcp", description: null, source: "extension", builtinMcp: false }],
      truncated: false,
    });
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/mc");
    await shown(page.container);
    await press(area, { key: "Enter" });
    expect(current.navigate).not.toHaveBeenCalled();
    expect(area.value).toBe("/mcp ");
  });

  it("renders a description as text, clipped to 200 characters", async () => {
    setup({
      commands: [
        {
          name: "evil",
          description: `<img src=x onerror=alert(1)>${"y".repeat(400)}`,
          source: "prompt",
          builtinMcp: false,
        },
      ],
      truncated: false,
    });
    const page = await mount(<Probe />);
    await typeInto(field(page.container, "Message"), "/e");
    await shown(page.container);
    expect(page.container.querySelector("img")).toBeNull();
    const text = page.container.querySelector('[role="option"]')?.textContent ?? "";
    expect(text).toContain("<img src=x");
    expect(text.length).toBeLessThanOrEqual("/evil".length + 200);
  });

  it("stays closed, without an error, when the list cannot be had (a cold session that fails to start)", async () => {
    const bed = setup();
    bed.handlers["sessions.commands"] = () => {
      throw new Error("capacity");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = await mount(<Probe />);
    const area = field(page.container, "Message");
    await typeInto(area, "/re");
    await settle();
    expect(latest?.open).toBe(false);
    expect(rows(page.container)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("pap: commands_list_failed");
    // Enter then is the textarea's own business.
    const enter = await press(area, { key: "Enter", ctrlKey: true });
    expect(enter.defaultPrevented).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns the ComposerMenu shape plus its menu", async () => {
    setup();
    await mount(<Probe />);
    expect(Object.keys(latest ?? {}).sort()).toEqual(
      ["close", "combobox", "fieldRef", "menu", "onKeyDown", "open"].sort(),
    );
    expect(latest?.combobox).toBeNull();
  });
});

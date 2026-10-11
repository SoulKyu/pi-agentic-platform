// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { COMMANDS, DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../defaults.ts";
import { installDispatcher } from "../dispatcher.ts";
import { registerCommand } from "../registry.ts";
import { mergeWithDefaults } from "../resolve.ts";
import { mount, press, settle, typeInto, type Mounted } from "../../../testing/dom.ts";
import CommandPalette from "./CommandPalette.tsx";
import type { PaletteItem } from "./rank.ts";

const runs = { split: vi.fn(), settings: vi.fn() };
const items: PaletteItem[] = [
  { id: "a1", group: "actions", title: "Open settings", searchTerms: ["Open settings"], run: runs.settings },
  {
    id: "a2",
    group: "actions",
    title: "Split pane",
    searchTerms: ["Split pane"],
    chord: ["Ctrl", "\\"],
    chordJoiner: "+",
    run: runs.split,
  },
  {
    id: "s1",
    group: "sessions",
    title: "pi-agentic",
    detail: "/home/ana/pi-agentic",
    searchTerms: ["pi-agentic"],
    run: () => {},
  },
];

let page: Mounted | null = null;
const onOpenChange = vi.fn();
beforeEach(() => {
  setLocale("en");
  runs.split.mockReset();
  runs.settings.mockReset();
  onOpenChange.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});
const open = async () => {
  page = await mount(
    <TooltipProvider>
      <CommandPalette open onOpenChange={onOpenChange} items={items} platform="other" />
    </TooltipProvider>,
  );
};
const input = () => document.querySelector("input") as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent);
const live = () => document.querySelector('[aria-live="polite"]')?.textContent;

describe("CommandPalette", () => {
  it("opens a labelled dialog with the input focused and the groups listed", async () => {
    await open();
    expect(document.querySelector("[data-pap-modal] [data-command-palette]")).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).toBe("Search commands and sessions");
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((el) => el.textContent)).toEqual([
      "Actions",
      "Sessions",
    ]);
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("filters with its own ranking and runs the chosen row with Enter, closing first", async () => {
    await open();
    await typeInto(input(), "split");
    expect(options()).toHaveLength(1);
    await press(input(), { key: "Enter" });
    expect(runs.split).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("binds no digit chord while the palette is open: the real dispatcher claims none of them", async () => {
    const platform = "other";
    const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
    const claimed = vi.fn();
    const offs = COMMANDS.map((command) => registerCommand(command.id, () => void claimed(command.id)));
    const stop = installDispatcher({
      win: window,
      platform,
      rules: () => rules,
      shell: () => ({ mobile: false, treeOpen: false }),
    });
    try {
      await open();
      const events = [];
      for (const digit of "123456789") {
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, ctrlKey: true }));
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, altKey: true }));
        events.push(await press(input(), { key: digit, code: `Digit${digit}`, ctrlKey: true, altKey: true }));
      }
      expect([events.length, events.filter((event) => event.defaultPrevented).length]).toEqual([27, 0]);
      expect(claimed).not.toHaveBeenCalled();
    } finally {
      stop();
      offs.forEach((off) => off());
    }
  });

  it("says when nothing matches, and when no action does", async () => {
    await open();
    await typeInto(input(), "zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "No match. Try a folder, a setting or an action.",
    );
    await typeInto(input(), "> zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe("No matching action.");
  });

  it("announces the result count politely, with its own singular", async () => {
    await open();
    expect(live()).toBe("3 results");
    await typeInto(input(), "split");
    expect(live()).toBe("1 result");
  });

  it("shows an item's chord as a Kbd", async () => {
    await open();
    const row = [...document.querySelectorAll('[role="option"]')].find((el) =>
      el.textContent?.includes("Split"),
    );
    expect([...(row?.querySelectorAll("kbd kbd") ?? [])].map((k) => k.textContent)).toEqual(["Ctrl", "\\"]);
  });

  it("renders in French", async () => {
    setLocale("fr");
    await open();
    await typeInto(input(), "zz");
    expect(document.querySelector("[cmdk-empty]")?.textContent).toBe(
      "Aucun résultat. Essayez un dossier, un réglage ou une action.",
    );
    expect(live()).toBe("0 résultat");
    await settle();
  });

  it("renders no listbox while closed", async () => {
    page = await mount(
      <TooltipProvider>
        <CommandPalette open={false} onOpenChange={onOpenChange} items={items} platform="other" />
      </TooltipProvider>,
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});

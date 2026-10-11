// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { mount, type Mounted } from "../../testing/dom.ts";
import ShortcutsHelp from "./ShortcutsHelp.tsx";
import { useKeybindingsStore } from "./keybindings-store.ts";

let page: Mounted | null = null;
beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  useKeybindingsStore.getState().setUser([]);
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});
const open = async () => {
  page = await mount(
    <TooltipProvider>
      <ShortcutsHelp open onOpenChange={() => {}} platform="other" />
    </TooltipProvider>,
  );
};
const row = (title: string) =>
  [...document.querySelectorAll("[data-command]")].find((el) => el.textContent?.includes(title));

describe("ShortcutsHelp", () => {
  it("lists commands with their title and Kbd tokens under group headings", async () => {
    await open();
    const dialog = document.querySelector("[data-pap-modal]");
    expect(dialog?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    const palette = row("Open the command palette");
    expect([...(palette?.querySelectorAll("kbd kbd") ?? [])].map((k) => k.textContent)).toEqual([
      "Ctrl",
      "K",
    ]);
    expect([...document.querySelectorAll("[data-group] h3")].map((h) => h.textContent)).toEqual([
      "Navigation",
      "Tabs",
      "Panes",
      "Session",
      "Agents",
      "App",
    ]);
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("does not list a command whose only rule is unbound, and shows the user's chord", async () => {
    useKeybindingsStore.getState().setUser([
      { key: "none", command: "tab.close" },
      { key: "alt+p", command: "palette.toggle" },
    ]);
    await open();
    expect(row("Close the tab")).toBeUndefined();
    expect(
      [...(row("Open the command palette")?.querySelectorAll("kbd kbd") ?? [])].map((k) => k.textContent),
    ).toEqual(["Alt", "P"]);
  });
});

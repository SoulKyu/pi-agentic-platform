// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import { click, mount } from "../../testing/dom.ts";
import { ViewerTabs } from "./ViewerTabs.tsx";

const show = (
  tabs: readonly string[],
  active: string | null,
  onSelect = vi.fn(),
  onClose = vi.fn(),
  dirty: ReadonlySet<string> = new Set(),
) =>
  mount(
    <TooltipProvider>
      <ViewerTabs
        tabs={tabs}
        active={active}
        idPrefix="tabs"
        panelId="panel"
        dirty={dirty}
        onSelect={onSelect}
        onClose={onClose}
      />
    </TooltipProvider>,
  );

describe("ViewerTabs", () => {
  it("one tab per open file, named by its file name, the active one selected", async () => {
    const { container } = await show(["/p/a.ts", "/p/dir/b.md"], "/p/dir/b.md");
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["a.ts", "b.md"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Open files");
  });

  it("selecting and closing report the path", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = await show(["/p/a.ts", "/p/b.ts"], "/p/a.ts", onSelect, onClose);
    await click(container.querySelectorAll('[role="tab"]')[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("/p/b.ts");
    await click(container.querySelector('button[aria-label="Close a.ts"]') as HTMLElement);
    expect(onClose).toHaveBeenCalledWith("/p/a.ts");
  });

  it("titles same-named files apart and marks the ones with unsaved edits", async () => {
    const { container } = await show(
      ["/p/a/i.ts", "/p/b/i.ts"],
      "/p/a/i.ts",
      vi.fn(),
      vi.fn(),
      new Set(["/p/b/i.ts"]),
    );
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "i.ts (a)",
      "i.ts (b)",
    ]);
    expect(container.querySelector('button[aria-label="Close i.ts (a)"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Close i.ts (b) (unsaved changes)"]')).not.toBeNull();
  });

  it("renders nothing when no file is open", async () => {
    const { container } = await show([], null);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});

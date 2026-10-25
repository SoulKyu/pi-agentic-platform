// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { duplicateNames } from "../../testing/names.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../shell/HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["models.overview"] = () => ({
    providers: [],
    defaults: { provider: null, model: null, thinkingLevel: null },
    enabled: { patterns: null, scope: "global", settingsPath: "/a/settings.json", warnings: [] },
    offline: false,
    truncated: false,
  });
  bed.handlers["mcp.overview"] = () => ({
    global: { path: "/g/mcp.json", problem: null, trusted: null, servers: [] },
    project: null,
    codemode: { autoEnable: true, source: "default" },
    settings: { choice: "automatic", mode: "on", inlineBudget: null },
    codemodeBuiltinOff: false,
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function shown(path: string, ready: string) {
  const page = await renderShell(path);
  await vi.waitFor(() => expect(page.container.querySelector(ready)).not.toBeNull(), { timeout: 5_000 });
  return page;
}
const headings = (root: ParentNode) =>
  [...root.querySelectorAll("h1, h2, h3, h4")].map((heading) => heading.tagName.toLowerCase());

describe("Settings headings", () => {
  it.each([
    ["models", "[data-models-section]"],
    ["mcp", "[data-mcp-section]"],
  ])("%s has no h3 right under the h1", async (name, ready) => {
    const page = await shown(`/settings/${name}`, ready);
    const levels = headings(page.container);
    expect(levels[0]).toBe("h1");
    expect(levels[1]).toBe("h2");
    await page.unmount();
  });

  it("Appearance's section titles are h2 in the section style, gap-s5 apart", async () => {
    const page = await shown("/settings/appearance", "[data-slot=appearance-status]");
    const titles = [...page.container.querySelectorAll("section[aria-labelledby] > header h2")];
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title.className).toBe("text-h2 text-fg");
    expect(page.container.querySelector("[data-slot=appearance-status]")?.parentElement?.className).toContain(
      "gap-s4",
    );
    const stack = titles[0]?.closest("section")?.parentElement;
    expect(stack?.className).toContain("gap-s5");
    expect(stack?.className).not.toContain("gap-s6");
    await page.unmount();
  });

  it.each([
    ["appearance", "[data-slot=appearance-status]"],
    ["approvals", "[data-settings-screen] h2"],
  ])("%s never skips a heading level", async (name, ready) => {
    const page = await shown(`/settings/${name}`, ready);
    const levels = headings(page.container).map((tag) => Number(tag.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((level, at) => {
      if (at > 0)
        expect(level, `${name} heading ${at}`).toBeLessThanOrEqual(Math.max(...levels.slice(0, at)) + 1);
    });
    await page.unmount();
  });

  it("Shortcuts has no h2 repeating the h1", async () => {
    const page = await shown("/settings/shortcuts", "[data-group]");
    expect(page.container.querySelector("h1")?.textContent).toBe("Keyboard shortcuts");
    expect(duplicateNames(page.container.querySelector("[data-settings-screen]") as HTMLElement)).toEqual([]);
    await page.unmount();
  });
});

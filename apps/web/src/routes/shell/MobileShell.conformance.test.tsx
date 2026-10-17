// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement: h } = await import("react");
  return { HomePane: () => h("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(
    shellSnapshot([shellSession({ id: "one", cwd: "/w/api" })], {
      projects: [shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 })],
    }),
  );
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.unstubAllGlobals();
});

/** The class names that give a control its 44 px target on a coarse pointer. */
const COARSE = /(^|\s)(pointer-coarse:)?(min-h-11|h-11|size-11)(\s|$)/;
/** Controls that are not touch targets by design: none today. */
const ALLOWED = new Set<string>([]);

const unsized = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>('button, [role="button"], a')]
    .filter((node) => !COARSE.test(node.className) && !ALLOWED.has(node.getAttribute("aria-label") ?? ""))
    .map((node) => `${node.tagName.toLowerCase()} "${node.getAttribute("aria-label") ?? node.textContent}"`);

describe("the phone shell: touch targets and the standalone frame (decision 32, board 12)", () => {
  it("the top bar carries the safe-area top inset so a standalone window clears the status bar", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    const bar = page.container.querySelector<HTMLElement>('[data-shell="mobile"] > header');
    expect(bar?.className).toContain("pt-safe");
    await page.unmount();
  });

  it("the logo link is a 44 px target on a coarse pointer", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    const logo = page.container.querySelector<HTMLElement>("header a");
    expect(logo?.className).toMatch(COARSE);
    expect(logo?.className).toContain("pointer-coarse:min-w-11");
    await page.unmount();
  });

  it("every button and link of the top bar and the four sections has the coarse 44 px class", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    const seen: string[] = [];
    for (const label of ["Agents", "Work", "Lists", "Inbox"]) {
      const nav = [...page.container.querySelectorAll<HTMLElement>('[data-slot="bottom-nav"] button')].find(
        (node) => node.textContent?.startsWith(label),
      );
      await click(nav as HTMLElement);
      await settle();
      await settle();
      seen.push(...unsized(page.container).map((name) => `${label}: ${name}`));
    }
    expect([...new Set(seen)]).toEqual([]);
    await page.unmount();
  });
});

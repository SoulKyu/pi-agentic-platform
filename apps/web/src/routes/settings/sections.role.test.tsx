// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import {
  EMPTY_WORKSPACE,
  OWNER_SECTIONS,
  sectionsFor,
  useWorkspaceStore,
} from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
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

const navLinks = () =>
  [...document.querySelectorAll('nav[aria-label="Settings sections"] a')].map((link) => link.textContent);
async function shown(path: string, role: "owner" | "member") {
  const page = await renderShell(path, { role });
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}

describe("Settings by role", () => {
  it("an owner's settings list has Models, MCP, Skills and Users", async () => {
    const page = await shown("/settings/language", "owner");
    expect(navLinks()).toEqual(
      expect.arrayContaining(["Models", "MCP servers", "Skills", "Users", "Health"]),
    );
    await page.unmount();
  });

  it("a member's settings list has no Models, MCP, Skills or Users, and still has Health", async () => {
    const page = await shown("/settings/language", "member");
    const links = navLinks();
    for (const gone of ["Models", "MCP servers", "Skills", "Users"]) expect(links).not.toContain(gone);
    expect(links).toContain("Health");
    expect(links).toContain("GitHub");
    await page.unmount();
  });

  it.each(["models", "mcp", "skills", "users"])(
    "a member's deep link to /settings/%s opens Appearance",
    async (section) => {
      const page = await shown(`/settings/${section}`, "member");
      expect(page.container.querySelector("h1")?.textContent).toBe("Appearance");
      await page.unmount();
    },
  );

  it("the owner sections are exactly the ones a member loses", () => {
    expect([...OWNER_SECTIONS].sort()).toEqual(["mcp", "models", "skills", "users"]);
    expect(sectionsFor("owner")).toContain("users");
    expect(sectionsFor("member")).not.toContain("users");
  });
});

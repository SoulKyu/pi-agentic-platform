// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { button, click, field, hasButton, settle, typeInto } from "../../testing/dom.ts";
import { RpcError } from "../../runtime/index.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn(), registerPasskey: vi.fn(), confirmPassword: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
  registerPasskey: auth.registerPasskey,
  confirmPassword: auth.confirmPassword,
}));
vi.mock("../shell/HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
let bed = fakeRuntime("open");
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
  auth.registerPasskey.mockReset().mockResolvedValue({ ok: true });
  auth.confirmPassword.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  document.documentElement.lang = "en";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function shown(path: string, options?: Parameters<typeof renderShell>[1]) {
  const page = await renderShell(path, options);
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}
const banner = () =>
  [...document.querySelectorAll('[data-slot="banner"]')].find(
    (el) => el.textContent?.includes("page seulement") || el.textContent?.includes("this page only"),
  ) ?? null;

describe("Language section", () => {
  it("switches the page language at once, without a reload, and stores it", async () => {
    const page = await shown("/settings/language");
    await click(button(page.container, "Français"));
    expect(document.documentElement.lang).toBe("fr");
    expect(localStorage.getItem("pap.locale")).toBe("fr");
    expect(
      document.querySelector('nav[aria-label="Sections des réglages"] a[aria-current="page"]')?.textContent,
    ).toBe("Langue");
    expect(banner()).toBeNull();
    await page.unmount();
  });

  it("says the choice applies to this page only when the browser refuses to store it", async () => {
    const page = await shown("/settings/language");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await click(button(page.container, "Français"));
    expect(document.documentElement.lang).toBe("fr");
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.textContent).toBe(
      "Appliqué à cette page seulement\u202f: ce navigateur ne garde pas les réglages.",
    );
    await page.unmount();
  });

  it("shows no banner when English is stored", async () => {
    const page = await shown("/settings/language");
    expect(banner()).toBeNull();
    expect(localStorage.getItem("pap.locale")).toBeNull();
    await page.unmount();
  });
});

describe("Account & devices section", () => {
  it("shows the username and offers a passkey only when passkeys are available", async () => {
    const without = await shown("/settings/account");
    expect(without.container.textContent).toContain("Signed in as");
    expect(without.container.querySelector("[data-settings-screen] p .font-mono")?.textContent).toBe("ana");
    expect(hasButton(without.container, "Add a passkey")).toBe(false);
    await without.unmount();
    const withKeys = await shown("/settings/account", { passkeysAvailable: true });
    expect(hasButton(withKeys.container, "Add a passkey")).toBe(true);
    await withKeys.unmount();
  });

  it("says Passkey added in a status line after the password is accepted", async () => {
    const page = await shown("/settings/account", { passkeysAvailable: true });
    await click(button(page.container, "Add a passkey"));
    await typeInto(field(page.container, "Password"), "hunter2 hunter2");
    await click(page.container.querySelector('button[type="submit"]') as HTMLElement);
    await settle();
    expect(auth.registerPasskey).toHaveBeenCalledWith("hunter2 hunter2");
    const status = [...page.container.querySelectorAll('[role="status"]')].map((el) => el.textContent);
    expect(status).toContain("Passkey added.");
    await page.unmount();
  });

  it("signs out through logout then onSignedOut", async () => {
    const onSignedOut = vi.fn();
    const page = await shown("/settings/account", { onSignedOut });
    await click(button(page.container, "Sign out"));
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("keeps the session and shows the error toast when logout fails", async () => {
    auth.logout.mockRejectedValue(new Error("down"));
    const onSignedOut = vi.fn();
    const page = await shown("/settings/account", { onSignedOut });
    await click(button(page.container, "Sign out"));
    await settle();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign-out did not reach pap. Try again.");
    expect(page.container.querySelector("[data-settings-screen]")).not.toBeNull();
    await page.unmount();
  });
});

describe("shortcuts section", () => {
  it("shows the shortcuts editor, not a placeholder", async () => {
    const page = await shown("/settings/shortcuts");
    expect(page.container.querySelector('[data-slot="empty-state"]')).toBeNull();
    expect(page.container.querySelector('[data-command="palette.toggle"]')).not.toBeNull();
    await page.unmount();
  });
});

describe("Models section", () => {
  const overview = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        origin: "builtin",
        auth: {
          oauthLabel: "Anthropic (Claude Pro/Max)",
          apiKey: true,
          configured: false,
          stored: null,
          status: "known",
          env: [],
        },
        models: [],
        modelsTruncated: false,
      },
    ],
    defaults: { provider: null, model: null, thinkingLevel: null },
    enabled: { patterns: null, scope: "global", settingsPath: "/a/settings.json", warnings: [] },
    offline: false,
    truncated: false,
  };

  it("is reachable at /settings/models, the path the model menu links to, and loads in its own chunk", async () => {
    bed.handlers["models.overview"] = () => overview;
    const page = await shown("/settings/models");
    await vi.waitFor(() => expect(page.container.querySelector("[data-models-section]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("Models");
    expect(
      page.container.querySelector('nav[aria-label="Settings sections"] a[aria-current="page"]')?.textContent,
    ).toBe("Models");
    await settle();
    expect(page.container.querySelector('[data-provider="anthropic"]')).not.toBeNull();
    await page.unmount();
  });

  it("is reachable at /settings/mcp, in a chunk of its own, and reads the servers of the project in the switcher", async () => {
    bed.handlers["mcp.overview"] = () => ({
      global: { path: "/g/mcp.json", problem: null, trusted: null, servers: [] },
      project: null,
      codemode: { autoEnable: true, source: "default" },
      settings: { choice: "automatic", mode: "on", inlineBudget: null },
      codemodeBuiltinOff: false,
    });
    const page = await shown("/settings/mcp");
    await vi.waitFor(() => expect(page.container.querySelector("[data-mcp-section]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("MCP servers");
    await settle();
    expect(bed.called("mcp.overview").map((call) => call.params)).toEqual([{}]);
    await page.unmount();
  });

  it("is reachable at /settings/skills, in a chunk of its own, and reads the skills of the project in the switcher", async () => {
    bed.handlers["skills.list"] = () => ({ skills: [], truncated: false });
    bed.handlers["plugins.list"] = () => ({ plugins: [], truncated: false });
    const page = await shown("/settings/skills");
    await vi.waitFor(() => expect(page.container.querySelector("[data-skills-section]")).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(page.container.querySelector("h1")?.textContent).toBe("Skills");
    await settle();
    expect(bed.called("skills.list").map((call) => call.params)).toEqual([{}]);
    expect(page.container.querySelector("[data-skill-install] [aria-pressed=true]")?.textContent).toBe(
      "All my projects",
    );
    await page.unmount();
  });

  it("asks for the password in M5's prompt before a sign-in starts, then retries once", async () => {
    bed.handlers["models.overview"] = () => overview;
    let attempts = 0;
    bed.handlers["models.login"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("step_up_required");
      return { flowId: "flow-1" };
    };
    bed.handlers["subscribe.login"] = () => ({ sub: "L1" });
    const page = await shown("/settings/models");
    await vi.waitFor(
      () => expect(page.container.querySelector('[data-provider="anthropic"]')).not.toBeNull(),
      {
        timeout: 5_000,
      },
    );
    await click(page.container.querySelector('[data-provider="anthropic"]') as HTMLElement);
    await click(button(page.container, "Sign in with Anthropic (Claude Pro/Max)"));
    await settle();
    const dialog = document.querySelector('[data-slot="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Confirm your password");
    await typeInto(field(dialog, "Password"), "correct horse battery staple");
    await click(button(dialog, "Confirm"));
    await settle();
    expect(auth.confirmPassword).toHaveBeenCalledWith("correct horse battery staple");
    expect(bed.called("models.login")).toHaveLength(2);
    expect(bed.called("subscribe.login").map((call) => call.params)).toEqual([{ flowId: "flow-1" }]);
    await page.unmount();
  });
});

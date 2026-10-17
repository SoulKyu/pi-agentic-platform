// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance, useAppearanceStore } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { button, click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

const summary = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0]?.replace(/^./, (c) => c.toUpperCase()) ?? id,
  initials: id.slice(0, 2).toUpperCase(),
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
  ...patch,
});
const AGENTS = [
  summary("atlas-1a2b", { state: "needs_input", unread: 3 }),
  summary("bolt-0001"),
  summary("cato-0002", { unread: 1 }),
];

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  bed.handlers["agents.sandboxStatus"] = () => ({
    usable: true,
    path: "/usr/bin/bwrap",
    reason: null,
    checkedAt: 1,
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useAgentsStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const withAgents = (agents: readonly AgentSummary[]) =>
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents, requests: [], truncated: false });
  });
const rail = () => document.querySelector<HTMLElement>('[data-slot="rail"]') as HTMLElement;
const avatars = () => [...rail().querySelectorAll<HTMLElement>('[data-slot="avatar"]')];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
// happy-dom answers `getModifierState("AltGraph")` with `altKey`, which the dispatcher reads as AltGr and ignores.
async function key(init: KeyboardEventInit, target: Element = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "getModifierState", { value: () => false });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
const chord = (n: number, target?: Element) =>
  key({ key: String(n), code: `Digit${n}`, ctrlKey: true, altKey: true }, target);
const altDown = (target?: Element) => key({ key: "ArrowDown", code: "ArrowDown", altKey: true }, target);
const altUp = (target?: Element) => key({ key: "ArrowUp", code: "ArrowUp", altKey: true }, target);
const pathname = (page: Awaited<ReturnType<typeof renderShell>>) => page.router.state.location.pathname;

describe("the agent rail (M11R108, board 05 option 2)", () => {
  it("lists one avatar per agent in creation order, each named with its state and unread count", async () => {
    const page = await renderShell("/");
    await withAgents(AGENTS);
    expect(avatars()).toHaveLength(3);
    const names = [...rail().querySelectorAll("button[aria-label]")].map((one) =>
      one.getAttribute("aria-label"),
    );
    expect(names.slice(0, 3)).toEqual(["Atlas, needs input, 3 unread", "Bolt, idle", "Cato, idle, 1 unread"]);
    expect(rail().querySelector('[data-slot="badge"] [aria-hidden]')?.textContent).toBe("3");
    expect(rail().querySelectorAll('[data-slot="badge"]')).toHaveLength(2);
    await page.unmount();
  });

  it("shows only the New agent button when there is no agent", async () => {
    const page = await renderShell("/");
    await withAgents([]);
    expect(avatars()).toEqual([]);
    expect(button(rail(), "New agent")).toBeTruthy();
    await page.unmount();
  });

  it.each([
    ["outlined", "border-agent text-agent", "bg-agent-fill"],
    ["tinted", "bg-agent/10", "bg-agent-fill"],
    ["glyph", "bg-agent-fill text-agent-ink", "bg-agent/10"],
  ] as const)("draws the avatars in the account's %s style", async (avatarStyle, has, hasNot) => {
    const page = await renderShell("/");
    act(() => {
      const { account, setAccount } = useAppearanceStore.getState();
      setAccount({ ...account, avatarStyle });
    });
    await withAgents([summary("bolt-0001")]);
    const classes = avatars()[0]?.className ?? "";
    for (const word of has.split(" ")) expect(classes).toContain(word);
    expect(classes.split(" ")).not.toContain(hasNot);
    await page.unmount();
  });

  it("scrolls inside the rail when the avatars pass its height, with New agent kept outside the scroll", async () => {
    const page = await renderShell("/");
    await withAgents(Array.from({ length: 20 }, (_, n) => summary(`agent${n}-000${n % 10}`)));
    const list = avatars()[0]?.closest("[data-slot='agent-rail']");
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("min-h-0");
    expect(list?.contains(button(rail(), "New agent"))).toBe(false);
    await page.unmount();
  });

  it("opens the agent's tab on a click, and marks it as the current one", async () => {
    const page = await renderShell("/");
    await withAgents(AGENTS);
    await click(button(rail(), "Bolt, idle"));
    await settle();
    expect(pathname(page)).toBe("/agents/bolt-0001");
    expect(useWorkspaceStore.getState().ws.active).toBe("agent:bolt-0001");
    expect(button(rail(), "Bolt, idle").getAttribute("aria-current")).toBe("page");
    expect(button(rail(), "Cato, idle, 1 unread").getAttribute("aria-current")).toBeNull();
    await page.unmount();
  });

  it("sends an agent whose profile is unreadable to Settings › Agents and says so in its name", async () => {
    const page = await renderShell("/");
    await withAgents([summary("atlas-1a2b", { state: "paused", unreadable: true })]);
    const name = "Atlas, paused, profile unreadable, opens Settings › Agents";
    await click(button(rail(), name));
    await settle();
    expect(pathname(page)).toBe("/settings/agents");
    await page.unmount();
  });

  it("opens the New agent dialog from the + button", async () => {
    const page = await renderShell("/", { chunks: ["newAgent"] });
    await withAgents([]);
    expect(dialog()).toBeNull();
    await click(button(rail(), "New agent"));
    await vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe("New agent"), {
      timeout: 2_000,
    });
    await page.unmount();
  });
});

describe("the agent shortcuts (M11R109)", () => {
  it("Ctrl+Alt+2 opens the second agent, keyed by the physical key", async () => {
    const page = await renderShell("/");
    await withAgents(AGENTS);
    // The character is not "2" on every layout while Ctrl+Alt is held; for a digit the physical key decides (M3R7).
    const event = await key({ key: "@", code: "Digit2", ctrlKey: true, altKey: true });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(pathname(page)).toBe("/agents/bolt-0001");
    await chord(1);
    await settle();
    expect(pathname(page)).toBe("/agents/atlas-1a2b");
    await page.unmount();
  });

  it("leaves Ctrl+Alt+9 to the browser when there is no ninth agent", async () => {
    const page = await renderShell("/");
    await withAgents(AGENTS);
    expect((await chord(9)).defaultPrevented).toBe(false);
    expect(pathname(page)).toBe("/");
    await page.unmount();
  });

  it("Alt+Down opens the next agent with unread and Alt+Up the previous one", async () => {
    const page = await renderShell("/agents/atlas-1a2b");
    await withAgents(AGENTS);
    await settle();
    expect((await altDown()).defaultPrevented).toBe(true);
    await settle();
    expect(pathname(page)).toBe("/agents/cato-0002");
    await altDown();
    await settle();
    expect(pathname(page)).toBe("/agents/atlas-1a2b");
    await altUp();
    await settle();
    expect(pathname(page)).toBe("/agents/cato-0002");
    await page.unmount();
  });

  it("leaves Alt+Down to the browser when no agent has unread activity", async () => {
    const page = await renderShell("/");
    await withAgents([summary("atlas-1a2b"), summary("bolt-0001")]);
    expect((await altDown()).defaultPrevented).toBe(false);
    expect(pathname(page)).toBe("/");
    await page.unmount();
  });

  it("does nothing while the caret is in a text field, the composer included (RT-19)", async () => {
    const page = await renderShell("/");
    await withAgents(AGENTS);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    for (const run of [() => chord(2, composer), () => altDown(composer), () => altUp(composer)])
      expect((await run()).defaultPrevented).toBe(false);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect((await chord(2, input)).defaultPrevented).toBe(false);
    expect(pathname(page)).toBe("/");
    composer.remove();
    input.remove();
    await page.unmount();
  });

  it("does nothing while a dialog is open", async () => {
    const page = await renderShell("/", { chunks: ["newAgent"] });
    await withAgents(AGENTS);
    await click(button(rail(), "New agent"));
    await vi.waitFor(() => expect(dialog()).not.toBeNull(), { timeout: 2_000 });
    (document.activeElement as HTMLElement | null)?.blur();
    for (const run of [() => chord(2), () => altDown(), () => altUp()])
      expect((await run()).defaultPrevented).toBe(false);
    expect(pathname(page)).toBe("/");
    await page.unmount();
  });
});

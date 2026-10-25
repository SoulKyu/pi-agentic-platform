// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import "../../features/sessions/register-session-catalog.ts";
import { Minimap } from "../../features/sessions/Minimap.tsx";
import { rowId } from "../../features/sessions/minimap.vm.ts";
import type { TranscriptItem } from "../../features/sessions/transcript.vm.ts";
import { EMPTY_WORKSPACE, pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { act } from "react";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { BottomNav } from "./BottomNav.tsx";

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
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  current.runtime = bed.runtime;
  localStorage.clear();
  useAgentsStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.unstubAllGlobals();
});

const user = (key: string): TranscriptItem => ({
  kind: "message",
  key,
  author: "you",
  text: "hello",
  thinking: "",
  entryId: key,
});

describe("current states", () => {
  it("the current agent, turn and bottom-nav section carry an agent rule, not only a text colour", async () => {
    const agent = {
      id: "atlas-1a2b",
      name: "Atlas",
      initials: "AT",
      state: "idle" as const,
      unread: 0,
      paused: false,
      quarantined: false,
      unreadable: false,
      threadSessionId: null,
      lastActivityAt: 1,
    };
    const shell = await renderShell(pathOfItem({ kind: "agent", id: agent.id }), { phone: false });
    act(() => {
      useAgentsStore.getState().apply({ kind: "snapshot", agents: [agent], requests: [], truncated: false });
    });
    const railButton = document.querySelector<HTMLElement>('[data-slot="rail"] button[aria-current="page"]');
    expect(railButton?.className).toContain("border-agent");
    expect(railButton?.className).toContain("bg-surface-2");
    expect(railButton?.className).not.toContain("border-transparent");
    await shell.unmount();

    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const minimap = await mount(
      createElement(
        "div",
        null,
        createElement("ol", null, createElement("li", { id: rowId("s", "u1") })),
        createElement(Minimap, { scope: "s", items: [user("u1")], view: EMPTY_VIEW, onLoadOlder: () => {} }),
      ),
    );
    const turn = minimap.container.querySelector<HTMLElement>("nav button") as HTMLElement;
    await act(async () => turn.click());
    expect(turn.getAttribute("aria-current")).toBe("true");
    expect(turn.className).toContain("border-l-2");
    expect(turn.className).toContain("border-agent");
    expect(turn.className).not.toContain("rounded-sm");
    expect(turn.className).toContain("text-fg");
    expect(turn.className).not.toContain("border-transparent");
    expect(turn.className.split(/\s+/)).not.toContain("text-muted");
    await minimap.unmount();

    const nav = await mount(
      createElement(BottomNav, { section: "work", inboxCount: 0, onSection: () => {} }),
    );
    const here = nav.container.querySelector<HTMLElement>('[aria-current="page"]');
    expect(here?.className).toContain("border-t-2");
    expect(here?.className).toContain("border-agent");
    expect(here?.className).not.toContain("border-transparent");
    expect(here?.className.split(/\s+/)).not.toContain("text-muted");
    await nav.unmount();
  });
});

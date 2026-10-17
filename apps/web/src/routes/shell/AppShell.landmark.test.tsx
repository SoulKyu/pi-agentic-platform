// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance, useAppearanceStore } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  useShellStore.getState().reset();
  bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

/** The real session screen, in the real shell: waits for its lazy chunk. */
async function openSession(path: string, phone: boolean) {
  const page = await renderShell(path, { phone });
  await vi.waitFor(() => expect(page.container.querySelector("[data-session-screen]")).not.toBeNull(), {
    timeout: 5_000,
  });
  await act(async () => bed.emit(sessionSnapshot({ status: "idle" })));
  return page;
}

describe("landmarks of the session screen in the shell", () => {
  it.each([
    ["desktop", false],
    ["phone", true],
  ])("has exactly one main landmark on /s/:id (%s), and the screen is a section", async (_name, phone) => {
    const page = await openSession("/s/abc", phone);
    expect(page.container.querySelectorAll("main, [role='main']")).toHaveLength(1);
    const screen = page.container.querySelector("[data-session-screen]");
    expect(screen?.tagName).toBe("SECTION");
    expect(screen?.closest("main")).not.toBeNull();
    await page.unmount();
  });

  it("has exactly one main landmark at / too, where the session list is a section", async () => {
    const page = await renderShell("/", { phone: false });
    await vi.waitFor(() => expect(page.container.querySelector('[data-pane-kind="home"]')).not.toBeNull());
    expect(page.container.querySelectorAll("main, [role='main']")).toHaveLength(1);
    await page.unmount();
  });
});

describe("the reconnect banner", () => {
  it("says the drafts stay on this device", async () => {
    const page = await renderShell("/", { phone: false });
    await act(async () => bed.fake.setState("waiting"));
    const status = [...page.container.querySelectorAll('[data-slot="banner"]')].map((el) => el.textContent);
    expect(status).toEqual(["The daemon is not answering.Your drafts stay on this device.Retry"]);
    await page.unmount();
  });
});

describe("the account's tool card detail reaches the session screen", () => {
  const withToolCall = {
    rows: [
      {
        entryId: "a1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }],
          timestamp: 1,
        },
      },
      {
        entryId: "t2",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "text", text: "contents of a.txt" }],
          timestamp: 2,
        },
      },
    ],
  };
  const output = (page: { container: HTMLElement }) =>
    page.container.querySelector('[data-slot="tool-card"] pre')?.textContent ?? null;

  it("opens a tool row's output when the account says expanded, and folds it when compact", async () => {
    useAppearanceStore.setState((state) => ({ account: { ...state.account, toolDetail: "expanded" } }));
    const page = await renderShell("/s/abc", { phone: false });
    await vi.waitFor(() => expect(page.container.querySelector("[data-session-screen]")).not.toBeNull(), {
      timeout: 5_000,
    });
    await act(async () => bed.fake.setState("open"));
    await vi.waitFor(() => expect(bed.called("subscribe.session")).toHaveLength(1));
    await act(async () => bed.emit(sessionSnapshot(withToolCall)));
    expect(output(page)).toBe("contents of a.txt");
    await act(async () =>
      useAppearanceStore.setState((state) => ({ account: { ...state.account, toolDetail: "compact" } })),
    );
    expect(output(page)).toBeNull();
    await page.unmount();
  });
});

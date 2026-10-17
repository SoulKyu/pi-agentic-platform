// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { itemOf, loadInbox } from "../../features/inbox/inbox-bed.tsx";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { usePwa } from "../../stores/pwa.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement: h } = await import("react");
  return { HomePane: () => h("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) => h("p", { "data-stub": "session" }, sessionId),
  };
});

const ID = "abcdefghijklmnopqrstuv";
let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["inbox.markRead"] = () => ({ updated: 1 });
  current.runtime = bed.runtime;
  localStorage.clear();
  setLocale("en");
  usePwa.setState(usePwa.getInitialState(), true);
  useInboxReveal.getState().clear();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([shellSession({ id: "one", needsInput: true })]));
  loadInbox([itemOf({ id: "q1" })]);
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  useInboxStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("the shell on /n/<id>", () => {
  it.each([false, true])("shows the landing in the main area (phone: %s)", async (phone) => {
    bed.handlers["push.open"] = () => {
      throw new RpcError("not_found");
    };
    const page = await renderShell(`/n/${ID}`, { phone });
    await vi.waitFor(() => expect(text(page.container)).toContain("This notification no longer exists"), {
      timeout: 3_000,
    });
    expect(bed.called("push.open").map((call) => call.params)).toEqual([{ id: ID }]);
  });

  it("answers a path that is not a push id with the same notice and no call", async () => {
    const page = await renderShell("/n/short");
    await vi.waitFor(() => expect(text(page.container)).toContain("This notification no longer exists"), {
      timeout: 3_000,
    });
    expect(bed.called("push.open")).toEqual([]);
  });

  it("still answers any other unknown path with the not-found screen", async () => {
    const page = await renderShell("/nowhere");
    expect(text(page.container)).toContain("This page does not exist");
    expect(bed.called("push.open")).toEqual([]);
  });

  it("opens a session target on the session", async () => {
    bed.handlers["push.open"] = () => ({ target: { kind: "session", id: "one" } });
    const page = await renderShell(`/n/${ID}`, { phone: true });
    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe("/s/one"), { timeout: 3_000 });
    await vi.waitFor(() => expect(page.container.querySelector('[data-stub="session"]')).not.toBeNull(), {
      timeout: 3_000,
    });
  });

  it("opens the Inbox drawer on the item on a desktop", async () => {
    bed.handlers["push.open"] = () => ({ target: { kind: "inbox", id: "q1" } });
    const page = await renderShell(`/n/${ID}`, { phone: false });
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] [data-item-id=q1]")).not.toBeNull(), {
      timeout: 3_000,
    });
    expect(page.router.state.location.pathname).toBe("/");
    expect(useInboxReveal.getState().open).toBe(false);
  });

  it("opens the Inbox section on the item on a phone", async () => {
    bed.handlers["push.open"] = () => ({ target: { kind: "inbox", id: "q1" } });
    const page = await renderShell(`/n/${ID}`, { phone: true });
    await vi.waitFor(() => expect(page.container.querySelector("[data-item-id=q1]")).not.toBeNull(), {
      timeout: 3_000,
    });
    expect(page.container.querySelector("[data-inbox-panel]")).not.toBeNull();
  });
});

describe("the Inbox request of a landing", () => {
  it("is kept while the landing is still on the page, and acted on once the page has left it", async () => {
    useInboxReveal.getState().ask("q1");
    const page = await renderShell("/n/short");
    await settle();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(useInboxReveal.getState().open).toBe(true);
    await act(async () => {
      await page.router.navigate({ to: "/settings/$section", params: { section: "language" } });
    });
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] [data-item-id=q1]")).not.toBeNull(), {
      timeout: 3_000,
    });
  });
});

describe("the worker's open message", () => {
  const send = (path: string) => act(async () => usePwa.getState().openHandler?.(path));

  it("registers a handler on mount and drops it on unmount", async () => {
    expect(usePwa.getState().openHandler).toBeNull();
    const page = await renderShell("/");
    expect(usePwa.getState().openHandler).not.toBeNull();
    await page.unmount();
    expect(usePwa.getState().openHandler).toBeNull();
  });

  it("registers again after a sign-out reset and a new mount", async () => {
    const first = await renderShell("/");
    await first.unmount();
    usePwa.getState().reset();
    const second = await renderShell("/");
    expect(usePwa.getState().openHandler).not.toBeNull();
    await second.unmount();
  });

  it("navigates to /n/<valid id>", async () => {
    bed.handlers["push.open"] = () => {
      throw new RpcError("not_found");
    };
    const page = await renderShell("/");
    await send(`/n/${ID}`);
    await settle();
    expect(page.router.state.location.pathname).toBe(`/n/${ID}`);
  });

  it.each([
    "https://evil.example",
    "//evil",
    "/auth/x",
    "/n/short",
    `/n/${ID}/x`,
    `/n/${ID}?next=//evil`,
    "/",
  ])("does nothing for %s", async (path) => {
    const page = await renderShell("/settings/language");
    await send(path);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/language");
    expect(bed.called("push.open")).toEqual([]);
  });
});

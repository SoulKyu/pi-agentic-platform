// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p") };
});

beforeEach(() => {
  const bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  useInboxStore.getState().reset();
});

async function inboxButton(counts: { unread: number; toHandle: number }) {
  await renderShell("/");
  await settle();
  await act(async () => {
    useInboxStore.getState().apply({ kind: "snapshot", items: [], truncated: false, ...counts });
  });
  return document.querySelector<HTMLButtonElement>('button[aria-label^="Inbox"]') as HTMLButtonElement;
}
const badge = () => document.querySelector('[data-slot="badge"]');
const dot = () => document.querySelector('[data-slot="inbox-dot"]');

describe("the top bar's Inbox button", () => {
  it("shows the number to handle as a pink badge, in its accessible name", async () => {
    const button = await inboxButton({ unread: 5, toHandle: 2 });
    expect(badge()?.textContent).toContain("2");
    expect(button.getAttribute("aria-label")).toBe("Inbox: 2 to handle");
    expect(dot()).toBeNull();
  });

  it("shows a small neutral dot when nothing is to handle and some items are unread", async () => {
    const button = await inboxButton({ unread: 3, toHandle: 0 });
    expect(badge()).toBeNull();
    expect(dot()).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Inbox: unread items");
  });

  it("shows nothing when both are zero", async () => {
    const button = await inboxButton({ unread: 0, toHandle: 0 });
    expect(badge()).toBeNull();
    expect(dot()).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Inbox");
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;
const user = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});
const agent = (entryId: string, content: unknown[]) => ({
  entryId,
  message: { role: "assistant", content, timestamp: Number(entryId.slice(1)) },
});

function Live() {
  const view = useSessionStore((state) => state.views["sess-1"]) ?? EMPTY_VIEW;
  return <Transcript sessionId="sess-1" view={view} />;
}
async function show(patch: Record<string, unknown>) {
  useSessionStore.getState().apply("sess-1", sessionSnapshot(patch));
  page = await mount(<Live />);
  await settle();
  return page.container;
}

beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  act(() => setLocale("en"));
});

describe("Transcript in the shell", () => {
  it("is a named list whose rows sit in a column of the chat width", async () => {
    const container = await show({ rows: [user("u1", "hi")] });
    const list = container.querySelector("ol");
    expect(list?.getAttribute("aria-label")).toBe("Conversation");
    expect(list?.querySelector(":scope > li")?.className).toContain("max-w-chat");
  });

  it("puts repeated authors under one header, and tool calls with the agent that made them", async () => {
    const container = await show({
      rows: [
        user("u1", "first"),
        user("u2", "second"),
        agent("a3", [
          { type: "text", text: "one" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
        ]),
        agent("a4", [{ type: "text", text: "two" }]),
      ],
    });
    const groups = [...container.querySelectorAll('[data-slot="author-group"]')];
    expect(groups.map((group) => group.getAttribute("data-author"))).toEqual(["you", "agent"]);
    expect(groups.map((group) => group.querySelectorAll('[data-slot="message"]').length)).toEqual([2, 2]);
    expect(groups[1]?.querySelector('[data-slot="tool-card"]')).not.toBeNull();
    expect(groups.map((group) => group.querySelectorAll("header").length)).toEqual([1, 1]);
  });

  it("shows the labels of the transcript in the new language as soon as the locale switches", async () => {
    const container = await show({
      rows: [user("u1", "first"), agent("a2", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }])],
      history: { hasMore: true, oldestEntryId: "u1", turnsBefore: 2 },
    });
    expect(text(container)).toContain("Load older messages");
    expect(
      container.querySelector('[data-slot="author-group"][data-author="you"]')?.getAttribute("aria-label"),
    ).toBe("You");
    expect(text(container)).toContain("Waiting");
    await act(async () => setLocale("fr"));
    expect(text(container)).toContain("Charger les messages plus anciens");
    expect(
      container.querySelector('[data-slot="author-group"][data-author="you"]')?.getAttribute("aria-label"),
    ).toBe("Vous");
    expect(container.querySelector("ol")?.getAttribute("aria-label")).toBe("Échanges");
    expect(text(container)).toContain("En attente");
    expect(text(container)).not.toContain("Waiting");
  });

  it("shows the note of a message too large to show in the new language too", async () => {
    const container = await show({
      rows: [{ entryId: "u1", message: { role: "user", timestamp: 1, omitted: true, bytes: 5000 } }],
    });
    expect(text(container)).toContain("Message too large to show (5 KB).");
    await act(async () => setLocale("fr"));
    expect(text(container)).not.toContain("Message too large");
  });
});

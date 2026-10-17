// @vitest-environment happy-dom
import type { MemoryItemView, MemoryJournalView } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { RECENT_ITEMS, RECENT_JOURNAL, RecentMemory } from "./RecentMemory.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const items = (count: number): MemoryItemView[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    text: `memory ${index}`,
    createdAt: null,
    source: "agent",
  }));
const lines = (count: number): MemoryJournalView[] =>
  Array.from({ length: count }, (_, index) => ({
    at: `2026-10-16T07:${String(index).padStart(2, "0")}:00Z`,
    kind: index % 2 === 0 ? "add" : "forget",
    text: `line ${index}`,
    source: "agent",
  }));

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["memory.list"] = () => ({ items: items(8), journal: lines(30) });
});

describe("the status panel's memory (M11R152)", () => {
  it("reads the agent's own scope and shows its 5 newest memories as text", async () => {
    bed.handlers["memory.list"] = () => ({
      items: [{ ...items(1)[0], text: "<b>hi</b>\u202e" } as MemoryItemView, ...items(7)],
      journal: [],
    });
    const page = await mount(<RecentMemory agentId="atlas-1a2b" />);
    await settle();
    expect(bed.called("memory.list")[0]?.params).toEqual({ scope: { kind: "agent", id: "atlas-1a2b" } });
    expect(page.container.querySelectorAll("li")).toHaveLength(RECENT_ITEMS);
    expect(text(page.container)).toContain("<b>hi</b>");
    expect(page.container.querySelector("b")).toBeNull();
    expect(text(page.container)).not.toContain("\u202e");
  });

  it("has a Journal tab with the 20 newest lines and their kind in words", async () => {
    const page = await mount(<RecentMemory agentId="atlas-1a2b" />);
    await settle();
    await click(page.container.querySelector('[role="radio"][aria-checked="false"]') as Element);
    expect(page.container.querySelectorAll("li")).toHaveLength(RECENT_JOURNAL);
    expect(text(page.container)).toContain("Added");
    expect(text(page.container)).toContain("Forgotten");
  });

  it("says an agent without memory has none", async () => {
    bed.handlers["memory.list"] = () => ({ items: [], journal: [] });
    const page = await mount(<RecentMemory agentId="atlas-1a2b" />);
    await settle();
    expect(text(page.container)).toContain("This agent has no memory yet.");
  });

  it("says when the read failed, and reads again on Try again", async () => {
    let fail = true;
    bed.handlers["memory.list"] = () => {
      if (fail) throw new RpcError("internal");
      return { items: items(1), journal: [] };
    };
    const page = await mount(<RecentMemory agentId="atlas-1a2b" />);
    await settle();
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    await click(button(page.container, "Try again"));
    await settle();
    expect(text(page.container)).toContain("memory 0");
  });

  it("treats an answer of the wrong shape as a failed read, not a crash", async () => {
    bed.handlers["memory.list"] = () => ({ ok: true });
    const page = await mount(<RecentMemory agentId="atlas-1a2b" />);
    await settle();
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

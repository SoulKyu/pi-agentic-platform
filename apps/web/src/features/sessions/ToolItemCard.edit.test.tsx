// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle, text, type Mounted, useLoadingClock } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

import { ToolItemCard } from "./ToolItemCard.tsx";
import type { ToolItem } from "./transcript.vm.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
const edit = (patch: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  key: "a1:c1#0",
  toolCallId: "c1",
  name: "edit",
  summary: "README.md · +1 −1",
  status: "done",
  preview: "Edited README.md",
  truncatedChars: null,
  argsTruncated: false,
  resultEntryId: null,
  omittedBytes: null,
  ...patch,
});
const show = async (tool: ToolItem) => {
  page = await mount(<ToolItemCard item={tool} sessionId="sess-1" detail="expanded" />);
  await settle();
  return page.container;
};
const answer = (args: string | null) => {
  bed.handlers["sessions.toolOutput"] = () => ({
    text: "Edited README.md",
    truncated: false,
    isError: false,
    args,
  });
};

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("ToolItemCard, edit", () => {
  it("an opened edit card shows its diff, never raw JSON", async () => {
    answer(JSON.stringify({ path: "README.md", edits: [{ oldText: "old", newText: "new" }] }));
    const container = await show(edit({ argsTruncated: true }));
    expect(container.querySelector('[data-slot="diff-view"], [data-slot="diff-empty"]')).not.toBeNull();
    expect(text(container)).not.toContain('"oldText"');
    expect(text(container)).not.toContain('{"path"');
  });

  it("says so when an edit changed nothing, and how many edits are not drawn", async () => {
    const edits = Array.from({ length: 10 }, () => ({ oldText: "same", newText: "same" }));
    answer(JSON.stringify({ path: "a.md", edits }));
    const container = await show(edit());
    expect(container.querySelectorAll('[data-slot="diff-empty"]')).toHaveLength(8);
    expect(text(container)).toContain("2 more edits not shown");
    expect(text(container)).toContain("This edit changed nothing.");
  });

  it("the diff's loading line waits 100 ms and says loading, not Running", async () => {
    useLoadingClock();
    try {
      bed.handlers["sessions.toolOutput"] = () => new Promise(() => {});
      page = await mount(
        <ToolItemCard item={edit({ argsTruncated: true })} sessionId="sess-1" detail="expanded" />,
      );
      const container = page.container;
      expect(container.querySelector('[data-slot="loading-line"]')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      const line = container.querySelector('[data-slot="loading-line"]');
      expect(line?.textContent).toContain("Loading the edit…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("args that do not parse show the output as before", async () => {
    answer("{not json");
    const container = await show(edit({ summary: '{"x":1}' }));
    expect(container.querySelector('[data-slot="diff-view"], [data-slot="diff-empty"]')).toBeNull();
    expect(text(container)).toContain('{"x":1}');
    expect(text(container)).toContain("Edited README.md");
  });

  it("a failed edit shows its error, not a diff of a change that never happened", async () => {
    answer(JSON.stringify({ path: "README.md", edits: [{ oldText: "old", newText: "new" }] }));
    const container = await show(edit({ status: "failed", preview: "Could not find the text" }));
    expect(container.querySelector('[data-slot="diff-view"], [data-slot="diff-empty"]')).toBeNull();
    expect(text(container)).toContain("Could not find the text");
  });

  it("a failed request keeps the card as it was", async () => {
    bed.handlers["sessions.toolOutput"] = () => {
      throw new Error("boom");
    };
    const container = await show(edit());
    expect(text(container)).toContain("Edited README.md");
  });
});

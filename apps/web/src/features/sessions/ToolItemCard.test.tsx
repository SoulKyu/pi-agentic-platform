// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text, type Mounted } from "../../testing/dom.ts";
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
const item = (patch: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  key: "a1:c1#0",
  toolCallId: "c1",
  name: "read",
  summary: '{"path":"a.txt"}',
  status: "done",
  preview: "first 8000 chars",
  truncatedChars: 30000,
  argsTruncated: false,
  resultEntryId: null,
  omittedBytes: null,
  ...patch,
});
async function show(tool: ToolItem) {
  page = await mount(<ToolItemCard item={tool} sessionId="sess-1" detail={detail} />);
  await settle();
  return page.container;
}

let detail: "compact" | "expanded" | "full" = "expanded"; // the setting under test is the card's, not the default's
const setDetail = (next: typeof detail) => {
  detail = next;
};

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  setDetail("expanded");
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("ToolItemCard", () => {
  it("shows the name, the summary, the status and the preview in a bounded block", async () => {
    const container = await show(item({ status: "running" }));
    expect(text(container)).toContain("read");
    expect(text(container)).toContain('{"path":"a.txt"}');
    expect(container.querySelector('[data-slot="tool-card"]')?.getAttribute("data-status")).toBe("running");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("Running");
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("first 8000 chars");
    expect(pre?.className).toContain("max-h-64");
    expect(pre?.className).toContain("overflow-auto");
  });

  it("offers the whole output only when the preview was cut, and fetches it once", async () => {
    bed.handlers["sessions.toolOutput"] = () => ({
      text: "the whole output",
      truncated: false,
      isError: false,
      args: null,
    });
    const container = await show(item());
    const showAll = button(container, "Show the whole output (29 KB)");
    await click(showAll);
    await click(showAll);
    await settle();
    expect(bed.called("sessions.toolOutput")).toEqual([
      { method: "sessions.toolOutput", params: { sessionId: "sess-1", toolCallId: "c1" } },
    ]);
    expect(container.querySelector("pre")?.textContent).toBe("the whole output");
    expect(hasButton(container, "Show the whole output (29 KB)")).toBe(false);
  });

  it("asks for the output of its own turn by the entry of its result, when it has one", async () => {
    bed.handlers["sessions.toolOutput"] = () => ({
      text: "first",
      truncated: false,
      isError: false,
      args: null,
    });
    const container = await show(item({ resultEntryId: "t0" }));
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect(bed.called("sessions.toolOutput")[0]?.params).toEqual({
      sessionId: "sess-1",
      toolCallId: "c1",
      resultEntryId: "t0",
    });
  });

  it("says the output was too large to show here and still offers the whole output", async () => {
    bed.handlers["sessions.toolOutput"] = () => ({
      text: "all of it",
      truncated: false,
      isError: false,
      args: null,
    });
    const container = await show(item({ preview: "", truncatedChars: null, omittedBytes: 300_000 }));
    expect(text(container)).toContain("Output too large to show here.");
    await click(button(container, "Show the whole output (293 KB)"));
    await settle();
    expect(container.querySelector("pre")?.textContent).toBe("all of it");
  });

  it("shows an error, and does not reject unhandled, when the answer cannot be read", async () => {
    bed.handlers["sessions.toolOutput"] = () => null;
    const container = await show(item());
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect(alerts(container)).toEqual(["Something went wrong."]);
    expect(hasButton(container, "Try again")).toBe(true);
  });

  it("offers nothing when the preview is the whole output", async () => {
    const container = await show(item({ truncatedChars: null }));
    expect(hasButton(container, "Show the whole output (29 KB)")).toBe(false);
    expect(container.querySelector("[aria-expanded]")).not.toBeNull(); // the card's own disclosure only
  });

  it("renders the output as text", async () => {
    bed.handlers["sessions.toolOutput"] = () => ({
      text: "<b>x</b>",
      truncated: false,
      isError: false,
      args: null,
    });
    const container = await show(item());
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("<b>x</b>");
  });

  it("says the output is not available yet on not_found and offers to try again", async () => {
    let tries = 0;
    bed.handlers["sessions.toolOutput"] = () => {
      if (++tries === 1) throw new RpcError("not_found");
      return { text: "now here", truncated: false, isError: false, args: null };
    };
    const container = await show(item());
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect(text(container)).toContain("The output is not available yet.");
    await click(button(container, "Try again"));
    await settle();
    expect(bed.called("sessions.toolOutput")).toHaveLength(2);
    expect(container.querySelector("pre")?.textContent).toBe("now here");
    expect(text(container)).not.toContain("not available");
  });

  it("shows any other failure as an alert and keeps the retry", async () => {
    bed.handlers["sessions.toolOutput"] = () => {
      throw new RpcError("offline");
    };
    const container = await show(item());
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect(alerts(container)).toEqual(["pap is unreachable right now."]);
    expect(hasButton(container, "Try again")).toBe(true);
  });

  it("does not ask twice while the first request is in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    bed.handlers["sessions.toolOutput"] = () => new Promise((resolve) => (answer = resolve));
    const container = await show(item());
    const open = button(container, "Show the whole output (29 KB)");
    await click(open);
    await click(open);
    expect(bed.called("sessions.toolOutput")).toHaveLength(1);
    answer({ text: "done", truncated: false, isError: false, args: null });
    await settle();
  });

  it("shows the full arguments when the summary was cut and the daemon returned them", async () => {
    bed.handlers["sessions.toolOutput"] = () => ({
      text: "out",
      truncated: false,
      isError: false,
      args: '{"path":"long"}',
    });
    const container = await show(item({ argsTruncated: true }));
    await click(button(container, "Show the whole output (29 KB)"));
    await settle();
    expect([...container.querySelectorAll("pre")].map((pre) => pre.textContent)).toEqual([
      "out",
      '{"path":"long"}',
    ]);
  });

  it("keeps a hostile long tool name, summary and arguments inside the header (M3 triage)", async () => {
    const hostile = `ext_${"w".repeat(5000)}`;
    const container = await show(item({ name: hostile, summary: "s".repeat(5000) }));
    const name = [...container.querySelectorAll("span")].find((span) => span.textContent === hostile);
    expect(name?.className).toContain("min-w-0");
    expect(name?.className).toContain("truncate");
    expect(container.querySelector('[data-slot="tool-card"] span.flex')?.className).toContain("min-w-0");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows a failed call with its chip, its red frame and its output", async () => {
    const container = await show(
      item({ status: "failed", preview: "permission denied", truncatedChars: null }),
    );
    const card = container.querySelector('[data-slot="tool-card"]');
    expect(card?.getAttribute("data-status")).toBe("error");
    expect(card?.className).toContain("border-err");
    expect(text(container)).toContain("Failed");
    expect(container.querySelector("pre")?.textContent).toBe("permission denied");
  });

  it("shows a call with no output yet as a header only, saying it waits", async () => {
    const container = await show(item({ status: "waiting", preview: "", truncatedChars: null }));
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(text(container)).toContain("Waiting");
  });

  it("follows the account's detail setting: compact keeps the output folded until it is opened", async () => {
    setDetail("compact");
    const container = await show(item());
    expect(container.querySelector("pre")).toBeNull();
    await click(container.querySelector("[aria-expanded]") as Element);
    expect(container.querySelector("pre")?.textContent).toBe("first 8000 chars");
  });
});

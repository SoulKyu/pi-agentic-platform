// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ToolRow } from "./ToolRow.tsx";
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
  ...patch,
});
async function show(tool: ToolItem) {
  page = await mount(<ToolRow item={tool} sessionId="sess-1" />);
  await settle();
  return page.container;
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("ToolRow", () => {
  it("shows the name, the summary, the status and the preview in a bounded block", async () => {
    const container = await show(item({ status: "running" }));
    expect(text(container)).toContain("read");
    expect(text(container)).toContain('{"path":"a.txt"}');
    expect(text(container)).toContain("Running");
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
    await click(button(container, "Show the whole output (29 KB)"));
    await click(container.querySelector("button") ?? container);
    await settle();
    expect(bed.called("sessions.toolOutput")).toEqual([
      { method: "sessions.toolOutput", params: { sessionId: "sess-1", toolCallId: "c1" } },
    ]);
    expect(container.querySelector("pre")?.textContent).toBe("the whole output");
    expect(hasButton(container, "Show the whole output (29 KB)")).toBe(false);
  });

  it("offers nothing when the preview is the whole output", async () => {
    const container = await show(item({ truncatedChars: null }));
    expect(container.querySelector("button")).toBeNull();
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
      '{"path":"long"}',
      "out",
    ]);
  });
});

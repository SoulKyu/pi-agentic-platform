// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { click, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

import { ToolItemCard } from "./ToolItemCard.tsx";
import type { ToolItem } from "./transcript.vm.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const HEADER = "Script completed\nWall time 0.1 seconds\nOutput:\n";
const codemode = (patch: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  key: "a:cm1#0",
  toolCallId: "cm1",
  name: "codemode",
  summary: '{"code":"// both\\nconst a = 1;"}',
  status: "done",
  preview: `${HEADER}==> text 1/2 <==\nfirst\n==> text 2/2 <==\n<script>alert(1)</script>`,
  truncatedChars: null,
  argsTruncated: false,
  resultEntryId: null,
  omittedBytes: null,
  code: "// both\nconst a = await tools.read({ path: 'a' });\ntext(a);",
  nested: [
    { name: "read", args: '{"path":"a"}', status: "ok", durationMs: 4, error: null },
    { name: "bash", args: '{"command":"false"}', status: "error", durationMs: 1200, error: "exit 1" },
  ],
  ...patch,
});

let page: Mounted | null = null;
let detail: "compact" | "expanded" | "full" = "expanded";
async function show(tool: ToolItem) {
  page = await mount(<ToolItemCard item={tool} sessionId="s1" detail={detail} />);
  await settle();
  return page.container;
}
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  detail = "expanded";
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("ToolItemCard for codemode", () => {
  it("collapsed: the preview line, the call count and the wall time in the header", async () => {
    detail = "compact";
    const container = await show(codemode());
    const card = text(container);
    expect(card).toContain("codemode");
    expect(card).toContain("const a = await tools.read({ path: 'a' });");
    expect(card).toContain("2 calls");
    expect(card).toContain("0.1 s");
    expect(card).not.toContain('{"code"');
    expect(container.querySelector("[data-slot=codemode-script]")).toBeNull();
  });

  it("expanded: the script as a code block, one row per call, the output without its header", async () => {
    const container = await show(codemode());
    expect(container.querySelector("[data-slot=codemode-script]")?.textContent).toContain("// both");
    const rows = [...container.querySelectorAll("[data-slot=codemode-call]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("read");
    expect(rows[0]?.textContent).toContain('{"path":"a"}');
    expect(rows[0]?.textContent).toContain("4 ms");
    expect(rows[1]?.textContent).toContain("1.2 s");
    expect(rows[1]?.textContent).toContain("exit 1");
    expect(rows[1]?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Failed");
    const blocks = [...container.querySelectorAll("[data-slot=codemode-output]")].map((b) => b.textContent);
    expect(blocks).toEqual(["first", "<script>alert(1)</script>"]);
    expect(text(container)).not.toContain("Wall time");
    expect(text(container)).not.toContain("==> text");
  });

  it("keeps a script tag in the output as text", async () => {
    const container = await show(codemode());
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("[data-slot=codemode-output]")[1]?.textContent).toBe(
      "<script>alert(1)</script>",
    );
  });

  it("opens on click when the setting is compact", async () => {
    detail = "compact";
    const container = await show(codemode());
    const toggle = container.querySelector("button");
    if (!toggle) throw new Error("no toggle");
    await click(toggle);
    expect(container.querySelector("[data-slot=codemode-script]")).not.toBeNull();
  });

  it("shows a failed script's error text and the failed state", async () => {
    const container = await show(
      codemode({
        status: "failed",
        preview: "Script failed\nWall time 2 seconds\nOutput:\nScript error:\nboom",
        nested: [],
      }),
    );
    expect(container.querySelector("[data-slot=tool-card]")?.getAttribute("data-status")).toBe("error");
    expect(container.querySelector("[data-slot=codemode-output]")?.textContent).toBe("Script error:\nboom");
    expect(text(container)).toContain("2 s");
    expect(text(container)).not.toContain("calls");
  });

  it("fences external output and still strips the header inside it", async () => {
    const fenced = `<untrusted source="mcp" id="0123456789ab">\n${HEADER}secret page\n</untrusted id="0123456789ab">`;
    const container = await show(codemode({ preview: fenced }));
    const fence = container.querySelector("[data-slot=fence]");
    expect(fence?.textContent).toContain("secret page");
    expect(fence?.textContent).not.toContain("Wall time");
  });

  it("falls back to the generic card when the arguments carry no script", async () => {
    const container = await show(codemode({ code: undefined, summary: '{"x":1}' }));
    expect(container.querySelector("[data-slot=codemode-script]")).toBeNull();
    expect(text(container)).toContain('{"x":1}');
    expect(text(container)).toContain("Wall time 0.1 seconds");
  });

  it("falls back for another tool even with a code field", async () => {
    const container = await show(codemode({ name: "bash", summary: "ls" }));
    expect(container.querySelector("[data-slot=codemode-script]")).toBeNull();
    expect(text(container)).toContain("Script completed");
  });
});

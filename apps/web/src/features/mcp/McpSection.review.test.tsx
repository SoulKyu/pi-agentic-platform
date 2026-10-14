// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import { current, newBed, overviewOf, PROJECT_FILE, rowButton, show, switchOf } from "./mcp-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const ASK = `This changes ${PROJECT_FILE}, which can run commands later. Save anyway?`;

async function open(id: string, overview = overviewOf()) {
  const bed = newBed(overview);
  const page = await show();
  await settle();
  await click(rowButton(page.container, id));
  return { bed, page };
}

describe("review fixes (MC46)", () => {
  it("disables Always on with the visible reason when Pi's settings turn the codemode built-in off", async () => {
    newBed(overviewOf({ codemodeBuiltinOff: true }));
    const page = await show();
    await settle();
    expect(switchOf(page.container, "Always on").disabled).toBe(true);
    expect(text(page.container)).toContain("-builtin:codemode in extensions");
  });

  it("starts a fresh panel when the folder changes: selection, ask, undo offer and Test results are gone", async () => {
    const bed = newBed();
    bed.handlers["mcp.test"] = () => ({
      state: "connected",
      tools: ["t1"],
      toolsTruncated: false,
      message: null,
      at: 1,
    });
    bed.handlers["mcp.remove"] = () => ({ token: "tok-9", expiresInMs: 60_000 });
    const { mount } = await import("../../testing/dom.ts");
    const { McpSection } = await import("./McpSection.tsx");
    const { stepUp } = await import("./mcp-bed.tsx");
    const page = await mount(<McpSection stepUp={stepUp} cwd="/work/a" />);
    await settle();
    await click(rowButton(page.container, "project/local"));
    await click(button(page.container, "Test"));
    await settle();
    expect(text(page.container)).toContain("t1");
    await click(switchOf(page.container, "Server local"));
    expect(text(page.container)).toContain(ASK);
    await page.rerender(<McpSection stepUp={stepUp} cwd="/work/b" />);
    await settle();
    expect(text(page.container)).not.toContain(ASK);
    expect(text(page.container)).not.toContain("t1");
    expect(page.container.querySelector("[data-mcp-detail]")).toBeNull();
    expect(bed.called("mcp.overview").at(-1)?.params).toEqual({ cwd: "/work/b" });
  });

  it("sends a global Undo through the step-up, asking for the password once and retrying", async () => {
    const { RpcError } = await import("../../runtime/index.ts");
    const { prompt } = await import("./mcp-bed.tsx");
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.remove"] = () => ({ token: "tok-5", expiresInMs: 60_000 });
    await click(button(page.container, "Remove"));
    await settle();
    let attempts = 0;
    bed.handlers["mcp.undo"] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError("step_up_required");
      return { ok: true };
    };
    const asked = prompt.asked;
    await click(button(page.container, "Undo"));
    await settle();
    expect(prompt.asked).toBe(asked + 1);
    expect(bed.called("mcp.undo")).toHaveLength(2);
    expect(bed.called("mcp.undo")[1]?.options?.commandId).toBe("stub-command");
  });

  it("moves focus to Undo after Remove, to the restored row after Undo, and to the ask when it opens", async () => {
    const { bed, page } = await open("global/fs");
    // A real daemon answers with a new object each time; the focus waits for it.
    bed.handlers["mcp.overview"] = () => structuredClone(overviewOf());
    bed.handlers["mcp.remove"] = () => ({ token: "tok-6", expiresInMs: 60_000 });
    await click(button(page.container, "Remove"));
    await settle();
    expect(document.activeElement).toBe(button(page.container, "Undo"));
    await click(button(page.container, "Undo"));
    await settle();
    expect(document.activeElement).toBe(rowButton(page.container, "global/fs"));
    await click(switchOf(page.container, "Server local"));
    expect(document.activeElement).toBe(button(page.container, "Save"));
  });

  it("disables Save while another write is on its way", async () => {
    const { bed, page } = await open("global/fs");
    await click(switchOf(page.container, "Server local"));
    bed.handlers["mcp.setEnabled"] = () => new Promise(() => {});
    await click(switchOf(page.container, "All global servers"));
    expect(button(page.container, "Save").disabled).toBe(true);
  });

  it("lists a tool name that repeats without a duplicate key warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.test"] = () => ({
      state: "connected",
      tools: ["dup", "dup"],
      toolsTruncated: false,
      message: null,
      at: 1,
    });
    await click(button(page.container, "Test"));
    await settle();
    expect(error).not.toHaveBeenCalled();
  });
});

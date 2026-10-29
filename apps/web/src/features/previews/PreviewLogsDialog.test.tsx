// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { button, mount } from "../../testing/dom.ts";
import { PROJECT_BOX } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { PreviewLogsDialog } from "./PreviewLogsDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const settle = () => act(async () => {});
const body = () => document.body;
const logs = () => body().querySelector("[data-preview-logs]");

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});

const show = async () => {
  const page = await mount(<PreviewLogsDialog box={PROJECT_BOX} name="web" onClose={() => {}} />);
  await settle();
  return page;
};

describe("PreviewLogsDialog", () => {
  it("reads the logs of the service and shows them under its title", async () => {
    bed.handlers["previews.logs"] = () => ({ lines: ["listening on 8000", "GET / 200"] });
    await show();
    expect(bed.called("previews.logs")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(body().textContent).toContain("Logs of web");
    expect([...(logs()?.children ?? [])].map((line) => line.textContent)).toEqual([
      "listening on 8000",
      "GET / 200",
    ]);
  });

  it("renders every line as text: an <img> in a line stays text", async () => {
    bed.handlers["previews.logs"] = () => ({ lines: ['<img src=x onerror="alert(1)">', "<b>bold</b>"] });
    await show();
    expect(logs()?.querySelector("img")).toBeNull();
    expect(logs()?.querySelector("b")).toBeNull();
    expect(logs()?.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("drops ANSI colour codes and hidden characters, and keeps no markup of them", async () => {
    const bidi = String.fromCodePoint(0x202e);
    const zero = String.fromCodePoint(0x200b);
    const escape = String.fromCodePoint(0x1b);
    bed.handlers["previews.logs"] = () => ({
      lines: [`${escape}[31mred${escape}[0m ${bidi}evil${zero}text`],
    });
    await show();
    expect(logs()?.textContent).toBe("red eviltext");
    expect(logs()?.innerHTML).not.toContain("<span");
  });

  it("shows no more than the 200 lines of 512 characters the daemon bounds", async () => {
    bed.handlers["previews.logs"] = () => ({
      lines: Array.from({ length: 260 }, (_, index) => `${index}:${"x".repeat(600)}`),
    });
    await show();
    expect(logs()?.children.length).toBe(200);
    expect(logs()?.children[0]?.textContent?.length).toBe(512);
  });

  it("says when nothing was printed", async () => {
    bed.handlers["previews.logs"] = () => ({ lines: [] });
    await show();
    expect(body().textContent).toContain("Nothing printed yet.");
    expect(logs()).toBeNull();
  });

  it("a failed read is an inline error, and REFRESH reads again without polling", async () => {
    vi.useFakeTimers();
    let first = true;
    bed.handlers["previews.logs"] = () => {
      if (first) {
        first = false;
        throw new RpcError("box_stopped");
      }
      return { lines: ["back"] };
    };
    await show();
    expect(body().querySelector('[role="alert"]')?.textContent).toContain("box is stopped");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(bed.called("previews.logs")).toHaveLength(1);
    await act(async () => button(body(), "Refresh").click());
    expect(bed.called("previews.logs")).toHaveLength(2);
    expect(logs()?.textContent).toBe("back");
    vi.useRealTimers();
  });
});

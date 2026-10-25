// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { highlightCode } from "./highlight.ts";

vi.mock("./highlight.ts", () => ({ highlightCode: vi.fn(async () => null) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(highlightCode).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("CodeBlock while a reply streams (M3 triage: no highlighting on every delta)", () => {
  it("does not highlight a fence that grows by a delta every few milliseconds, then highlights the settled one once", async () => {
    const page = await mount(<CodeBlock code="const a" lang="ts" />);
    let code = "const a";
    for (let delta = 0; delta < 20; delta++) {
      code += " = 1;\nconst b";
      await page.rerender(<CodeBlock code={code} lang="ts" />);
      await advance(40);
    }
    expect(highlightCode).not.toHaveBeenCalled();
    await advance(1000);
    expect(highlightCode).toHaveBeenCalledTimes(1);
    expect(highlightCode).toHaveBeenCalledWith(code, "ts");
    await page.unmount();
  });

  it("shows the plain code meanwhile and drops a pending highlight when the block goes away", async () => {
    const page = await mount(<CodeBlock code="let x" lang="ts" />);
    expect(page.container.querySelector("code")?.textContent).toBe("let x");
    await page.unmount();
    await advance(1000);
    expect(highlightCode).not.toHaveBeenCalled();
  });
});

describe("CodeBlock copy button", () => {
  const LABELS = { copy: "Copy code", copied: "Copied" };
  const button = (page: { container: HTMLElement }) => page.container.querySelector("button");
  const click = (page: { container: HTMLElement }) =>
    act(async () => {
      button(page)?.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("has no button without labels", async () => {
    const page = await mount(<CodeBlock code="ls" lang="sh" />);
    expect(button(page)).toBeNull();
    await page.unmount();
  });

  it("copies the code, says so, then offers to copy again", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const page = await mount(<CodeBlock code={"pnpm i\npnpm build"} lang="sh" labels={LABELS} />);
    expect(button(page)?.getAttribute("aria-label")).toBe("Copy code");
    await click(page);
    expect(writeText).toHaveBeenCalledWith("pnpm i\npnpm build");
    expect(button(page)?.getAttribute("aria-label")).toBe("Copied");
    await advance(1500);
    expect(button(page)?.getAttribute("aria-label")).toBe("Copy code");
    await page.unmount();
  });

  it("copies through a selected textarea where the Clipboard API is missing (plain HTTP on a LAN)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    let selected: string | undefined;
    const execCommand = vi.fn((command: string) => {
      selected = (document.activeElement as HTMLTextAreaElement | null)?.value;
      return command === "copy";
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    const page = await mount(<CodeBlock code="echo hi" lang="sh" labels={LABELS} />);
    await click(page);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(selected).toBe("echo hi");
    expect(document.querySelector("textarea")).toBeNull();
    expect(button(page)?.getAttribute("aria-label")).toBe("Copied");
    await page.unmount();
  });
});

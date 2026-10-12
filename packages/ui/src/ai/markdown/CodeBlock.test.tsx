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

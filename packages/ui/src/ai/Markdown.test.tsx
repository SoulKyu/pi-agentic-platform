// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Markdown } from "./Markdown.tsx";

describe("Markdown (lazy)", () => {
  it("shows the plain text at once, then the rendered markdown", async () => {
    const page = await mount(<Markdown text={"**hi** there"} />);
    expect(page.container.textContent).toContain("**hi** there");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(page.container.querySelector("strong")?.textContent).toBe("hi");
    await page.unmount();
  });
});

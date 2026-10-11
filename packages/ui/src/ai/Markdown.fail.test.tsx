// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Markdown } from "./Markdown.tsx";

vi.mock("./markdown/render.tsx", () => {
  throw new Error("chunk gone after an update");
});

describe("Markdown when its chunk cannot load", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the plain text and reports once", async () => {
    const onLoadError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught error
    const page = await mount(<Markdown text={"**hi**"} onLoadError={onLoadError} />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(page.container.textContent).toBe("**hi**");
    expect(onLoadError).toHaveBeenCalledOnce();
    await page.unmount();
  });
});

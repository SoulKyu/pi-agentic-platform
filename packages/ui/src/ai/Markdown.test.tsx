// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Markdown } from "./Markdown.tsx";

const gate = vi.hoisted(() => {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
});

// The renderer's import waits for the test, so "plain text first" does not depend on module caching or load.
vi.mock("./markdown/render.tsx", async (original) => {
  await gate.opened;
  return original();
});

describe("Markdown (lazy)", () => {
  it("shows the plain text at once, then the rendered markdown", async () => {
    const page = await mount(<Markdown text={"**hi** there"} />);
    expect(page.container.textContent).toBe("**hi** there");
    expect(page.container.querySelector("strong")).toBeNull();

    gate.release();
    await vi.waitFor(() => expect(page.container.querySelector("strong")?.textContent).toBe("hi"), {
      timeout: 2_000,
    });
    expect(page.container.textContent).toBe("hi there");
    await page.unmount();
  });
});

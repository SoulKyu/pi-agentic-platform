// @vitest-environment happy-dom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Button } from "./Button.tsx";

describe("Button (DESIGN.md §9.1)", () => {
  it("is a plain button unless told otherwise", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it("fills primary with the you colour and its own ink", () => {
    const html = renderToStaticMarkup(<Button variant="primary">Send</Button>);
    expect(html).toContain("bg-you-fill");
    expect(html).toContain("text-you-ink");
  });

  it("draws danger as an error outline and ghost without a border colour", () => {
    expect(renderToStaticMarkup(<Button variant="danger">Delete</Button>)).toMatch(
      /border-err[\s"].*text-err|text-err.*border-err/,
    );
    expect(renderToStaticMarkup(<Button variant="ghost">More</Button>)).toContain("border-transparent");
  });

  it("sets labels as HUD labels, keeps the focus ring and a 44 px target on touch", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    for (const cls of [
      "label-hud",
      "focus-ring",
      "pointer-coarse:min-h-11",
      "pointer-coarse:min-w-11",
      "h-control",
    ])
      expect(html).toContain(cls);
  });

  it("keeps the DOM text in sentence case (selectors never depend on CSS text-transform, R121)", () => {
    expect(renderToStaticMarkup(<Button>Allow once</Button>)).toContain(">Allow once<");
  });

  it("cannot shrink by default, and truncate lets it shrink with an ellipsis label", () => {
    const plain = renderToStaticMarkup(<Button>Save</Button>);
    expect(plain).toContain("shrink-0 ");
    expect(plain).toContain("whitespace-nowrap");
    const cut = renderToStaticMarkup(<Button truncate>A very long project name</Button>);
    expect(cut).toContain("min-w-0");
    expect(cut).not.toContain("shrink-0");
    expect(cut).toMatch(/<span class="[^"]*truncate[^"]*">A very long project name<\/span>/);
  });

  it("uses a fixed 24 px row for the sm size", () => {
    expect(renderToStaticMarkup(<Button size="sm">Go</Button>)).toContain("h-6");
  });
});

describe("Button pending feedback (DESIGN.md §7.3)", () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("disables a remote action at once, spins after 200 ms and shows the stage label after 3 s", async () => {
    now = 10;
    const page = await mount(
      <Button pendingSince={10} stageLabel="Preparing worktree…">
        Create
      </Button>,
    );
    const button = page.container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(page.container.querySelector('[data-slot="spinner"]')).toBeNull();
    await act(async () => {
      now = 210;
      vi.advanceTimersByTime(200);
    });
    expect(page.container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => {
      now = 3010;
      vi.advanceTimersByTime(2800);
    });
    expect(button.textContent).toBe("Preparing worktree…");
    await page.unmount();
  });

  it("stage shows with the spinner from the start of the wait", async () => {
    now = 10;
    const page = await mount(
      <Button pendingSince={10} stage="Building the image…">
        Rebuild
      </Button>,
    );
    const button = page.container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Building the image…");
    expect(page.container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await page.unmount();
  });

  it("the stage label is said once in a polite region when the step changes", async () => {
    now = 10;
    const page = await mount(
      <Button pendingSince={10} stage="Building the image…">
        Rebuild
      </Button>,
    );
    const region = () => page.container.querySelector('[role="status"]');
    expect(region()?.textContent).toBe("Building the image…");
    expect(region()?.className).toContain("sr-only");
    expect(region()?.getAttribute("aria-live")).toBe("polite");
    expect(region()?.closest("button")).toBeNull();
    await page.rerender(
      <Button pendingSince={10} stage="Preparing the disk…">
        Rebuild
      </Button>,
    );
    expect(page.container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(region()?.textContent).toBe("Preparing the disk…");
    await page.rerender(<Button>Rebuild</Button>);
    expect(page.container.querySelector('[role="status"]')).toBeNull();
    await page.unmount();
  });
});

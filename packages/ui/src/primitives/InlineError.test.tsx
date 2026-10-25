// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { InlineError } from "./InlineError.tsx";

describe("InlineError", () => {
  it("is red with the warning icon and its words by default", async () => {
    const page = await mount(<InlineError announce="action">Could not save.</InlineError>);
    const error = page.container.querySelector('[data-slot="inline-error"]') as HTMLElement;
    expect(error.tagName).toBe("P");
    expect(error.className).toContain("text-err");
    expect(error.textContent).toBe("Could not save.");
    expect(error.querySelector('[data-slot="icon"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("tone attn is pink", async () => {
    const page = await mount(
      <InlineError tone="attn" announce="action">
        Answer needed.
      </InlineError>,
    );
    const error = page.container.querySelector('[data-slot="inline-error"]') as HTMLElement;
    expect(error.className).toContain("text-attn");
    expect(error.className).not.toContain("text-err");
  });

  it("announce action is an alert, background a polite status", async () => {
    const page = await mount(
      <>
        <InlineError announce="action">A</InlineError>
        <InlineError announce="background" id="b">
          B
        </InlineError>
      </>,
    );
    const [first, second] = [...page.container.querySelectorAll('[data-slot="inline-error"]')];
    expect(first?.getAttribute("role")).toBe("alert");
    expect(second?.getAttribute("role")).toBe("status");
    expect(second?.id).toBe("b");
  });
});

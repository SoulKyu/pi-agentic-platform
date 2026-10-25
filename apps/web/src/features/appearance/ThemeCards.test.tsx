// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../../testing/dom.ts";
import { ThemeCards, type ThemeCardOption } from "./ThemeCards.tsx";

const swatch = { side: "#000000", bg: "#111111", agent: "#22d3ee" };
const options: ThemeCardOption[] = [
  { id: "night", name: "Night", tag: "default", swatch },
  { id: "long", name: "A very long custom theme name that must wrap", tag: "custom", swatch },
];

describe("ThemeCards", () => {
  it("shows each theme's whole name and its tag on a line of its own", async () => {
    const page = await mount(
      <ThemeCards label="Dark theme" value="night" options={options} onChange={() => {}} />,
    );
    const card = page.container.querySelector('[data-theme-card="long"]') as HTMLElement;
    const name = card.querySelector("[data-theme-name]") as HTMLElement;
    const tag = card.querySelector("em") as HTMLElement;
    expect(name.textContent).toBe(options[1]?.name);
    expect(name.className).not.toContain("truncate");
    expect(name.className).toContain("break-words");
    expect(name.parentElement).toBe(tag.parentElement);
    expect(name.parentElement?.className).toContain("flex-col");
  });
});

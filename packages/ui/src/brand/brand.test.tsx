import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Mark } from "./Mark.tsx";
import { Wordmark } from "./Wordmark.tsx";

describe("logo (DESIGN.md §6)", () => {
  it("draws the two legs on the 32-unit grid: bar in text colour, agent left, you right", () => {
    const svg = renderToStaticMarkup(<Mark label="pap" />);
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain('<rect class="fill-fg" x="6" y="9" width="20" height="3.2"');
    expect(svg).toContain('<rect class="fill-agent" x="10.4" y="12" width="3.2" height="13"');
    expect(svg).toContain(
      'class="fill-you" d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z"',
    );
    expect(svg).toContain('role="img"');
  });

  it("never goes below 16 px and can pin a theme's tones", () => {
    expect(renderToStaticMarkup(<Mark size={8} />)).toContain('width="16"');
    expect(renderToStaticMarkup(<Mark mode="day" />)).toContain('data-theme="day"');
    expect(renderToStaticMarkup(<Mark />)).toContain('aria-hidden="true"');
  });

  it("sets the name in Manrope 800, lower case, tight, with a mono tagline", () => {
    const html = renderToStaticMarkup(<Wordmark name="pap" tagline="pi agentic platform" />);
    for (const cls of ["font-extrabold", "tracking-display", "lowercase", "label-hud"])
      expect(html).toContain(cls);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar.tsx";

describe("ProgressBar", () => {
  it("is determinate with a value, clamped to its range", () => {
    const html = renderToStaticMarkup(<ProgressBar value={150} max={100} label="Budget" />);
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("width:100%");
  });
  it("is the thin indeterminate bar without one (the running tool card)", () => {
    const html = renderToStaticMarkup(<ProgressBar label="Running" />);
    expect(html).toContain("animate-indeterminate");
    expect(html).not.toContain("aria-valuenow");
  });
  it.each([
    [Number.NaN, 100, "0", "0%"],
    [-5, 100, "0", "0%"],
    [Number.POSITIVE_INFINITY, 100, "100", "100%"],
    [50, 0, "50", "50%"],
    [50, Number.NaN, "50", "50%"],
    [50, -10, "50", "50%"],
  ] as const)("sanitises value %s and max %s to aria-valuenow %s, width %s", (value, max, now, width) => {
    const html = renderToStaticMarkup(<ProgressBar value={value} max={max} label="Budget" />);
    expect(html).toContain(`aria-valuenow="${now}"`);
    expect(html).toContain(`width:${width}`);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
  it("reports the range it used: a bad max becomes 100", () => {
    const html = renderToStaticMarkup(
      <ProgressBar value={20} max={Number.POSITIVE_INFINITY} label="Budget" />,
    );
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="20"');
  });
});

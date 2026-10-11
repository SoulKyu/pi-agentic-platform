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
});

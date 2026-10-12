// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { ToolCard } from "./ToolCard.tsx";

const card = (detail: "compact" | "expanded" | "full", status: "running" | "done" | "error" = "done") =>
  renderToStaticMarkup(
    <ToolCard
      name="bash"
      summary="go test ./..."
      duration="00:07"
      status={status}
      detail={detail}
      runningLabel="Running"
      failedLabel="Failed"
    >
      ok lanes 0.41s
    </ToolCard>,
  );

describe("ToolCard (DESIGN.md §9.2)", () => {
  it("names the tool in mono upper case in agent colour, with its summary and duration", () => {
    const html = card("expanded");
    expect(html).toContain("label-hud");
    expect(html).toContain("text-agent");
    expect(html).toContain("go test ./...");
    expect(html).toContain(">00:07<");
  });

  it("is one line in compact detail, clipped when expanded, whole when full", () => {
    expect(card("compact")).not.toContain("ok lanes 0.41s");
    expect(card("expanded")).toContain("max-h-64");
    expect(card("full")).not.toContain("max-h-64");
  });

  it("shows the indeterminate bar while running and a failed chip on error", () => {
    expect(card("compact", "running")).toContain("animate-indeterminate");
    expect(card("compact", "error")).toContain(">Failed<");
  });

  it("follows a later change of the detail setting until the person toggles it", async () => {
    const view = (detail: "compact" | "expanded") => (
      <ToolCard name="bash" status="done" detail={detail} runningLabel="Running" failedLabel="Failed">
        out
      </ToolCard>
    );
    const page = await mount(view("compact"));
    expect(page.container.textContent).not.toContain("out");
    await page.rerender(view("expanded"));
    expect(page.container.textContent).toContain("out");
    await page.unmount();
  });

  it("truncates a hostile long tool name instead of overflowing the header (M3 triage)", () => {
    const name = `ext_${"w".repeat(5000)}`;
    const html = renderToStaticMarkup(
      <ToolCard name={name} status="done" detail="compact" runningLabel="Running" failedLabel="Failed" />,
    );
    const span = new RegExp(`<span class="([^"]*)">${name}</span>`).exec(html);
    expect(span?.[1]).toContain("min-w-0");
    expect(span?.[1]).toContain("truncate");
    expect(span?.[1]).not.toContain("shrink-0");
  });

  it("shows the name, the failed chip and no body in a header-only error card", () => {
    const html = renderToStaticMarkup(
      <ToolCard name="bash" status="error" detail="full" runningLabel="Running" failedLabel="Failed" />,
    );
    expect(html).toContain('data-status="error"');
    expect(html).toContain("border-err");
    expect(html).toContain(">Failed<");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("collapsible");
  });

  it("shows an error card's output when there is one, open under 'expanded'", async () => {
    const page = await mount(
      <ToolCard name="bash" status="error" detail="expanded" runningLabel="Running" failedLabel="Failed">
        permission denied
      </ToolCard>,
    );
    expect(page.container.querySelector("pre")?.textContent).toBe("permission denied");
    expect(page.container.textContent).toContain("Failed");
    await page.unmount();
  });

  it("a header-only running card still shows the progress bar", () => {
    const html = renderToStaticMarkup(
      <ToolCard name="bash" status="running" detail="compact" runningLabel="Running" failedLabel="Failed" />,
    );
    expect(html).toContain("animate-indeterminate");
    expect(html).not.toContain("<pre");
  });

  it("shows a status word for a card that is neither running nor failed, and a footer under the output", async () => {
    const page = await mount(
      <ToolCard
        name="read"
        status="done"
        detail="expanded"
        statusLabel="Done"
        footer={<button type="button">Show all</button>}
        runningLabel="Running"
        failedLabel="Failed"
      >
        out
      </ToolCard>,
    );
    expect(page.container.textContent).toContain("Done");
    expect(page.container.querySelector("button[type=button]:not([aria-expanded])")?.textContent).toBe(
      "Show all",
    );
    expect(page.container.querySelector("pre")?.textContent).toBe("out");
    await page.unmount();
  });

  it("opens a footer-only card (no output text) under 'expanded'", async () => {
    const page = await mount(
      <ToolCard
        name="read"
        status="done"
        detail="expanded"
        footer={<span data-footer>Output too large</span>}
        runningLabel="Running"
        failedLabel="Failed"
      />,
    );
    expect(page.container.querySelector("[data-footer]")).not.toBeNull();
    expect(page.container.querySelector("pre")).toBeNull();
    await page.unmount();
  });
});

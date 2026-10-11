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
});

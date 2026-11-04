import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconSettings } from "../icons.ts";
import { IconButton } from "./IconButton.tsx";
import { TooltipProvider } from "./Tooltip.tsx";

describe("IconButton", () => {
  it("names itself with its label and never uses the native title", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton icon={IconSettings} label="Settings" />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain("title=");
    expect(html).toContain("size-control");
  });
});

describe("IconButton badge", () => {
  it("shows the count badge above zero and not at zero", () => {
    const withBadge = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton icon={IconSettings} label="Inbox" badge={{ count: 3, label: "3 unread" }} />
      </TooltipProvider>,
    );
    expect(withBadge).toContain('data-slot="badge"');
    expect(withBadge).toContain("3 unread");
    const none = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton icon={IconSettings} label="Inbox" badge={{ count: 0, label: "0 unread" }} />
      </TooltipProvider>,
    );
    expect(none).not.toContain('data-slot="badge"');
  });
});

describe("IconButton selected", () => {
  const html = (selected?: boolean) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <IconButton icon={IconSettings} label="Overview" selected={selected} />
      </TooltipProvider>,
    );
  it("marks the current page and takes the agent border and surface fill", () => {
    const on = html(true);
    expect(on).toContain('aria-current="page"');
    expect(on).toContain("border-agent");
    expect(on).toContain("bg-surface-2");
  });
  it("says nothing when not selected", () => {
    expect(html(false)).not.toContain("aria-current");
    expect(html()).not.toContain("border-agent");
  });
});

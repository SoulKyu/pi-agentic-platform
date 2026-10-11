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

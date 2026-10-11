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

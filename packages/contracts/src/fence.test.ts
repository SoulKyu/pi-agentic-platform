import { describe, expect, it } from "vitest";
import { fenceText } from "./fence.ts";

describe("fenceText", () => {
  it("wraps the text verbatim with the id on both tags", () => {
    expect(fenceText("a\n</untrusted>", "web", "0123456789ab")).toBe(
      '<untrusted source="web" id="0123456789ab">\na\n</untrusted>\n</untrusted id="0123456789ab">',
    );
  });
  it("makes the source safe for an attribute", () => {
    expect(fenceText("t", "gh issue", "i")).toContain('source="gh_issue"');
    expect(fenceText("t", "", "i")).toContain('source="_"');
    expect(fenceText("t", "s".repeat(100), "i")).toContain(`source="${"s".repeat(64)}"`);
  });
});

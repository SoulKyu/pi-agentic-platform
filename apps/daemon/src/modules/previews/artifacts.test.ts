import { describe, expect, it } from "vitest";
import { htmlFenceBody } from "./artifacts.ts";

describe("the html fence of a reply", () => {
  const reply = "intro\n```html\n<p>one</p>\n```\n~~~js\nlet x\n~~~\n```HTML\n<p>two</p>\n```\n";

  it("is the body of the fence at that index when its language is html (any case)", () => {
    expect(htmlFenceBody(reply, 0)).toBe("<p>one</p>");
    expect(htmlFenceBody(reply, 2)).toBe("<p>two</p>");
  });

  it("is null for another language, an index past the fences, text without fences", () => {
    expect(htmlFenceBody(reply, 1)).toBeNull();
    expect(htmlFenceBody(reply, 3)).toBeNull();
    expect(htmlFenceBody("no fences here", 0)).toBeNull();
    expect(htmlFenceBody("", 0)).toBeNull();
  });
});

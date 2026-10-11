import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button.tsx";

describe("Button", () => {
  it("is a plain button unless told otherwise", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it("shows the 2 px orange fill focus ring, offset 2 px, never the human text tone", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain("focus-ring");
  });

  it("keeps a 44 px target on coarse pointers", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain("pointer-coarse:min-h-11");
  });

  it("danger is an error outline", () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete</Button>);
    expect(html).toContain("border-error");
    expect(html).toContain("text-error");
  });
});

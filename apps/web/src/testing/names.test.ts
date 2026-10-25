// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { duplicateNames } from "./names.ts";

const parse = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

describe("duplicateNames", () => {
  it("finds two headings, two landmarks or two buttons of a group with one name", () => {
    expect(duplicateNames(parse("<h2>Rules</h2><h3>Rules</h3><h2>Other</h2>"))).toEqual(["Rules"]);
    expect(duplicateNames(parse('<nav aria-label="Main"></nav><nav aria-label="Main"></nav>'))).toEqual([
      "Main",
    ]);
    expect(
      duplicateNames(
        parse(
          '<h2 id="t">Lists</h2><section aria-labelledby="t"></section><section aria-label="Lists"></section>',
        ),
      ),
    ).toContain("Lists");
    expect(
      duplicateNames(
        parse('<div role="group"><button>Save</button><button>Save</button><button>Go</button></div>'),
      ),
    ).toEqual(["Save"]);
    expect(duplicateNames(parse("<div><button>Save</button></div><div><button>Save</button></div>"))).toEqual(
      [],
    );
  });
});

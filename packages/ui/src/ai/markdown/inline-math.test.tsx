import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { pandocDollars } from "./inline-math.ts";

/** Every code element as `<code data-class="…">`: what the renderer's `code` and `pre` entries are handed. */
function codes(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkMath, pandocDollars]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => <code data-class={className}>{children}</code>,
      }}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("pandocDollars", () => {
  it('"$5 and $10" stays text', () => {
    const out = codes("It costs $5 and $10 in total");
    expect(out).not.toContain("<code");
    expect(out).toContain("It costs $5 and $10 in total");
  });

  it("$x^2$ is math", () => {
    const out = codes("so $x^2$ here");
    expect(out).toContain('data-class="language-math math-inline"');
    expect(out).toContain(">x^2<");
  });

  it("$$\\int$$ is display math", () => {
    const out = codes("$$\\int$$");
    expect(out).toContain("math-display");
    expect(out).toContain("\\int");
  });

  it("a block between $$ lines is display math", () => {
    expect(codes("$$\na^2 + b^2\n$$")).toContain("math-display");
  });

  it("$ x$ and $x $ stay text", () => {
    expect(codes("a $ x$ b")).not.toContain("<code");
    expect(codes("a $x $ b")).not.toContain("<code");
  });

  it("a digit right after the closing $ keeps the text", () => {
    expect(codes("a $x$5 b")).not.toContain("<code");
  });

  it("math after a price still renders", () => {
    const out = codes("$5 and $10 but $y$ is math");
    expect(out).toContain(">y<");
    expect(out).toContain("$5 and $10 but ");
  });
});

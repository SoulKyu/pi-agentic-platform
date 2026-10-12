import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Message } from "./Message.tsx";

describe("Message", () => {
  it("marks an agent message with the 2 px agent rule and a violet name", () => {
    const html = renderToStaticMarkup(
      <Message author="agent" label="Atlas">
        Done.
      </Message>,
    );
    expect(html).toContain('data-author="agent"');
    expect(html).toContain("border-l-2");
    expect(html).toContain("border-agent");
    expect(html).toContain("text-agent");
    expect(html).toContain(">Atlas<");
  });

  it("draws your message as a right-aligned tinted box", () => {
    const html = renderToStaticMarkup(
      <Message author="you" label="YOU">
        Hello
      </Message>,
    );
    expect(html).toContain('data-author="you"');
    expect(html).toContain("bg-you-tint");
    expect(html).toContain("border-you-line");
    expect(html).toContain("text-you-text");
    expect(html).toContain("ml-auto");
    expect(html).not.toContain("border-l-2");
    expect(html).toContain(">YOU<");
  });

  it("keeps tool output on a neutral rule", () => {
    const html = renderToStaticMarkup(
      <Message author="tool" label="bash">
        ok
      </Message>,
    );
    expect(html).toContain("border-border");
    expect(html).not.toContain("border-agent");
  });

  it("shows your message as a right-aligned tint box and the agent's behind a 2 px violet rule", () => {
    const you = renderToStaticMarkup(
      <Message author="you" label="You">
        hi
      </Message>,
    );
    for (const cls of ["ml-auto", "bg-you-tint", "border-you-line", "text-you-text"])
      expect(you).toContain(cls);
    const agent = renderToStaticMarkup(
      <Message author="agent" label="Atlas">
        ok
      </Message>,
    );
    expect(agent).toContain("border-l-2");
    expect(agent).toContain("border-agent");
  });

  it("drops its own header inside an author group and shows meta otherwise", () => {
    expect(
      renderToStaticMarkup(
        <Message author="agent" label="Atlas" grouped>
          ok
        </Message>,
      ),
    ).not.toContain("<header");
    expect(
      renderToStaticMarkup(
        <Message author="agent" label="Atlas" meta="14:02">
          ok
        </Message>,
      ),
    ).toContain(">14:02<");
  });
});

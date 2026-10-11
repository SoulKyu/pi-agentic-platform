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
    expect(html).toContain("bg-human-tint");
    expect(html).toContain("border-human-line");
    expect(html).toContain("text-human-text");
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
    expect(html).toContain("border-line");
    expect(html).not.toContain("border-agent");
  });
});

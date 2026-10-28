// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { clearSelection, QuoteFixture, select } from "../../../testing/quote-bed.tsx";
import { mount } from "../../../testing/dom.ts";
import { useQuoteSelection } from "./use-quote-selection.ts";

function Probe() {
  const selection = useQuoteSelection("s1");
  return <output data-probe>{selection === null ? "none" : selection.text}</output>;
}
const probe = () => document.querySelector("[data-probe]")?.textContent;

afterEach(clearSelection);

describe("useQuoteSelection", () => {
  it("a selection inside one agent message of this screen yields its text", async () => {
    await mount(
      <QuoteFixture>
        <Probe />
      </QuoteFixture>,
    );
    await select("reply-1");
    expect(probe()).toBe("First reply with a passage to quote");
    await select("reply-2");
    expect(probe()).toBe("Second reply");
    await clearSelection();
    expect(probe()).toBe("none");
  });

  it("a selection across two messages, into your own row, into a tool card or in another screen yields none", async () => {
    await mount(
      <QuoteFixture>
        <Probe />
      </QuoteFixture>,
    );
    for (const [from, to] of [
      ["reply-1", "reply-2"],
      ["reply-2", "mine"],
      ["mine", "mine"],
      ["tool", "tool"],
      ["elsewhere", "elsewhere"],
      ["reply-1", "tool"],
    ] as const) {
      await select(from, to);
      expect(probe(), `${from} to ${to}`).toBe("none");
    }
  });
});

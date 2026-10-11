// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips } from "../testing/dom.ts";
import { AuthorGroup } from "./AuthorGroup.tsx";
import { DaySeparator } from "./DaySeparator.tsx";
import { Fence } from "./Fence.tsx";
import { Message, MessageBranch } from "./Message.tsx";
import { RunStatusChip } from "./RunStatusChip.tsx";

describe("conversation components (DESIGN.md §9.2)", () => {
  it("an author group shows one header for consecutive messages", () => {
    const html = renderToStaticMarkup(
      <AuthorGroup author="agent" name="Atlas" meta="14:02">
        <Message author="agent" label="Atlas" grouped>
          one
        </Message>
        <Message author="agent" label="Atlas" grouped>
          two
        </Message>
      </AuthorGroup>,
    );
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain("text-agent");
  });

  it("a day separator is an inline labelled line, not sticky", () => {
    const html = renderToStaticMarkup(<DaySeparator label="Today" />);
    expect(html).toContain('role="separator"');
    expect(html).not.toContain("sticky");
  });

  it("maps run states to chip tones: needs input is attention, interrupted is error", () => {
    expect(renderToStaticMarkup(<RunStatusChip status="needs-input" label="Needs input" />)).toContain(
      'data-tone="att"',
    );
    expect(renderToStaticMarkup(<RunStatusChip status="interrupted" label="Interrupted" />)).toContain(
      'data-tone="err"',
    );
    expect(renderToStaticMarkup(<RunStatusChip status="working" label="Working" />)).toContain(
      'data-tone="run"',
    );
  });

  it("fences external content with a dashed attention frame and its label", () => {
    const html = renderToStaticMarkup(<Fence label="UNTRUSTED · webhook prod-alerts">payload</Fence>);
    expect(html).toContain("border-dashed");
    expect(html).toContain("border-attn");
    expect(html).toContain("UNTRUSTED · webhook prod-alerts");
  });

  it("the branch selector wraps around, hides below two and names its group", async () => {
    expect(
      renderToStaticMarkup(
        <MessageBranch
          index={0}
          count={1}
          groupLabel="Branches"
          previousLabel="Previous"
          nextLabel="Next"
          position="1 / 1"
          onChange={() => {}}
        />,
      ),
    ).toBe("");
    const onChange = vi.fn();
    const page = await mountWithTooltips(
      <MessageBranch
        index={0}
        count={3}
        groupLabel="Branches"
        previousLabel="Previous"
        nextLabel="Next"
        position="1 / 3"
        onChange={onChange}
      />,
    );
    expect(page.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Branches");
    await click(page.container.querySelector('button[aria-label="Previous"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(2);
    await click(page.container.querySelector('button[aria-label="Next"]') as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith(1);
    await page.unmount();
  });
});

// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { click, mountWithTooltips } from "../testing/dom.ts";
import { AuthorGroup } from "./AuthorGroup.tsx";
import { DaySeparator } from "./DaySeparator.tsx";
import { Fence } from "./Fence.tsx";
import { Message, MessageAction, MessageActions, MessageBranch } from "./Message.tsx";
import { IconSplit } from "../icons.ts";
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

  it("shows hostile content in a fence as text, and lets an unbroken string wrap inside the frame", () => {
    const hostile = `<img src=x onerror="alert(1)"><script>alert(2)</script>${"A".repeat(5000)}`;
    const html = renderToStaticMarkup(
      <Fence label={'UNTRUSTED · <b onclick="x()">peer</b>'}>{hostile}</Fence>,
    );
    expect(html).not.toMatch(/<img|<script|<b[ >]/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b onclick=&quot;x()&quot;&gt;peer&lt;/b&gt;");
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("gives every run state a tone, and a dot only to the two that need a person's eye", () => {
    const states = [
      ["working", "run", true],
      ["settled", "ok", false],
      ["interrupted", "err", false],
      ["limited", "mut", false],
      ["needs-input", "att", true],
    ] as const;
    for (const [status, tone, dot] of states) {
      const html = renderToStaticMarkup(<RunStatusChip status={status} label={status} />);
      expect(html, status).toContain(`data-tone="${tone}"`);
      expect(html.includes("chip-dot"), status).toBe(dot);
      expect(html, status).toContain(`>${status}<`);
    }
  });

  it("names the message actions as a group, and each icon action by its label, with no native title", async () => {
    const onClick = vi.fn();
    const page = await mountWithTooltips(
      <MessageActions label="Message actions">
        <MessageAction label="Fork from here" icon={IconSplit} onClick={onClick} />
        <MessageAction label="Edit from here" icon={IconSplit} disabled />
      </MessageActions>,
    );
    expect(page.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Message actions",
    );
    await click(page.container.querySelector('button[aria-label="Fork from here"]') as HTMLElement);
    expect(onClick).toHaveBeenCalledOnce();
    expect(
      page.container.querySelector<HTMLButtonElement>('button[aria-label="Edit from here"]')?.disabled,
    ).toBe(true);
    expect(page.container.querySelector("[title]")).toBeNull();
    await page.unmount();
  });
});

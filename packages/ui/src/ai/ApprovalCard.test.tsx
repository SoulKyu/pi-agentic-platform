// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

const noop = () => {};
const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;
const names = (container: HTMLElement) => [...container.querySelectorAll("button")].map((b) => b.textContent);

function render(detail: string): string {
  return renderToStaticMarkup(
    <ApprovalCard title="Approval needed" detail={detail} labels={LABELS} onChoose={noop} />,
  );
}

/** The scrollable region and the fixed header, as the markup carries them. */
function regions(html: string): {
  header: string;
  scroll: string | undefined;
  headerAt: number;
  scrollAt: number;
} {
  const header = /<pre data-approval-header[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  const scroll = /<pre data-approval-scroll[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  return {
    header: header?.[1] ?? "",
    scroll: scroll?.[1],
    headerAt: header?.index ?? -1,
    scrollAt: scroll?.index ?? -1,
  };
}

describe("ApprovalCard", () => {
  it("renders an accessible alertdialog with the request and both answers", () => {
    const html = render("Run a command?\nbash: echo hi");
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-label="Approval needed"');
    expect(html).toContain("bash: echo hi");
    expect(html).toContain(">Allow once<");
    expect(html).toContain(">Deny<");
  });

  it("shows the detail as text, never as markup or markdown", () => {
    const html = render(
      '12 characters, 1 line\nbash: <img src=x onerror="alert(1)"> **bold** [x](http://e.test) <b>b</b>',
    );
    expect(html).not.toMatch(/<img|<b>|<strong|<a /);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("**bold** [x](http://e.test) &lt;b&gt;b&lt;/b&gt;");
  });

  it("keeps the escaped hidden-character markers and spacing as sent", () => {
    const detail = "3 characters, 1 line, 1 hidden character shown escaped\nbash:   \\u{202E}  a\tb";
    expect(regions(render(detail)).scroll).toBe("bash:   \\u{202E}  a\tb");
  });

  it("keeps the header line outside the scrollable region, above it", () => {
    const { header, scroll, headerAt, scrollAt } = regions(
      render("40 characters, 3 lines\n→ /etc/hosts (outside the session directory)\nwrite: {}"),
    );
    expect(header).toBe("40 characters, 3 lines");
    expect(scroll).toBe("→ /etc/hosts (outside the session directory)\nwrite: {}");
    expect(headerAt).toBeGreaterThanOrEqual(0);
    expect(headerAt).toBeLessThan(scrollAt);
  });

  it("shows a long detail whole in the flow of the card: no inner scroll, no tail lost", () => {
    const padding = "\n".repeat(500);
    const html = render(`header\nbash: start${padding}TAIL-OF-THE-COMMAND`);
    const { scroll } = regions(html);
    expect(scroll).toContain("TAIL-OF-THE-COMMAND");
    expect(scroll?.endsWith("TAIL-OF-THE-COMMAND")).toBe(true);
    expect(scroll?.split("\n").length).toBe(501);
    const tag = /<pre data-approval-scroll[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).not.toMatch(/max-h|overflow/);
    expect(tag).toContain("font-mono");
  });

  it("keeps blank lines at the start of the scrollable text", () => {
    // A browser drops the first newline right after <pre>; the markup carries one more so none is lost.
    expect(regions(render("header\n\nbody")).scroll).toBe("\n\nbody");
  });

  it("treats a detail without a line break as scrollable text with no header", () => {
    const { header, scroll } = regions(render("Run a command?"));
    expect(header).toBe("");
    expect(scroll).toBe("Run a command?");
  });

  it("renders a header alone, and an empty detail, without a scroll region", () => {
    expect(regions(render("only a header\n")).header).toBe("only a header");
    expect(regions(render("only a header\n")).scroll).toBeUndefined();
    expect(regions(render("")).scroll).toBeUndefined();
    expect(regions(render("")).header).toBe("");
  });

  it("describes the dialog by its header and its scrollable text", () => {
    const html = render("12 characters, 1 line\nbash: echo hi");
    const describedBy = /<section[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? "";
    const headerId = /<pre data-approval-header[^>]*id="([^"]+)"/.exec(html)?.[1];
    const scrollId = /<pre data-approval-scroll[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(headerId).toBeDefined();
    expect(scrollId).toBeDefined();
    expect(describedBy).toBe(`${headerId} ${scrollId}`);
  });

  it("describes the dialog only by what is rendered", () => {
    const noBreak = render("Run a command?");
    const scrollId = /<pre data-approval-scroll[^>]*id="([^"]+)"/.exec(noBreak)?.[1];
    expect(scrollId).toBeDefined();
    expect(/<section[^>]*aria-describedby="([^"]+)"/.exec(noBreak)?.[1]).toBe(scrollId);

    const headerOnly = render("only a header\n");
    const headerId = /<pre data-approval-header[^>]*id="([^"]+)"/.exec(headerOnly)?.[1];
    expect(/<section[^>]*aria-describedby="([^"]+)"/.exec(headerOnly)?.[1]).toBe(headerId);

    expect(render("")).not.toContain("aria-describedby");
  });

  it("styles the card as an attention-tinted card", () => {
    const html = render("h\nb");
    expect(html).toContain("bg-attn-tint");
    expect(html).toContain("border-attn-line");
    expect(html).toContain("rounded-md");
  });

  it("offers all four answers by default, in DESIGN order, and calls onChoose once", async () => {
    const onChoose = vi.fn();
    const page = await mount(
      <ApprovalCard
        title="Approval"
        category="external write"
        taintLabel="External content"
        detail={"1 line\npush origin main"}
        labels={LABELS}
        onChoose={onChoose}
      />,
    );
    expect(names(page.container)).toEqual(["Deny", "Session", "Always", "Allow once"]);
    expect(page.container.textContent).toContain("external write");
    expect(page.container.querySelector('[data-tone="ext"]')?.textContent).toBe("External content");
    await click(button(page.container, "Session"));
    await click(button(page.container, "Allow once"));
    expect(onChoose.mock.calls).toEqual([["session"]]);
    await page.unmount();
  });

  it("offers exactly the answers it is given, in DESIGN order, and always Deny", async () => {
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail="x"
        answers={["once", "session", "once"]}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    expect(names(page.container)).toEqual(["Deny", "Session", "Allow once"]);
    await page.unmount();
  });

  it("offers Deny and Allow once when asked for those two, and answers once", async () => {
    const onChoose = vi.fn();
    const page = await mount(
      <ApprovalCard
        title="Approval"
        detail="x"
        answers={["deny", "once"]}
        labels={LABELS}
        onChoose={onChoose}
      />,
    );
    expect(names(page.container)).toEqual(["Deny", "Allow once"]);
    await click(button(page.container, "Allow once"));
    await click(button(page.container, "Deny"));
    expect(onChoose.mock.calls).toEqual([["once"]]);
    await page.unmount();
  });

  it("keeps the header in sentence case in the DOM; CSS uppercases it (R121)", () => {
    const html = renderToStaticMarkup(
      <ApprovalCard title="Approval" category="exec" detail="x" labels={LABELS} onChoose={() => {}} />,
    );
    expect(html).toMatch(/<h3[^>]*class="[^"]*label-hud[^"]*text-attn-title/);
    expect(html).toContain(">Approval<");
    expect(html).not.toContain("APPROVAL");
  });
});

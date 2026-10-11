// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mount, press } from "../testing/dom.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Banner } from "./Banner.tsx";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Meter } from "./Meter.tsx";
import { OpenTab } from "./OpenTab.tsx";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("status and structure (DESIGN.md §9.1, §2)", () => {
  it("chips always carry a word; external content is dashed attention", () => {
    expect(html(<Chip tone="run" label="Working" />)).toContain(">Working<");
    expect(html(<Chip tone="ext" label="External content" />)).toMatch(
      /border-dashed[^"]*border-attn|border-attn[^"]*border-dashed/,
    );
    expect(html(<Chip tone="att" label="Needs input" dot />)).toContain('data-slot="chip-dot"');
  });

  it("badges are round attention fills, capped at 99+, with an accessible label", () => {
    const badge = html(<Badge count={120} label="120 unread" />);
    expect(badge).toContain(">99+<");
    expect(badge).toContain("rounded-full");
    expect(badge).toContain("bg-attn-fill");
    expect(badge).toContain("120 unread");
  });

  it("avatars are outlined initials by default and can show presence and a count", () => {
    const avatar = html(
      <Avatar initials="AT" name="Atlas" presence="waiting" badge={{ count: 2, label: "2 unread" }} />,
    );
    expect(avatar).toContain("border-agent");
    expect(avatar).toContain('data-presence="waiting"');
    expect(html(<Avatar initials="AT" name="Atlas" avatarStyle="glyph" />)).toContain("bg-agent-fill");
  });

  it("meters use agent for tokens and you for cost", () => {
    expect(html(<Meter label="Tokens today" value={10} max={100} kind="tokens" valueText="10k" />)).toContain(
      "bg-agent-fill",
    );
    expect(html(<Meter label="Cost today" value={1} max={4} kind="cost" valueText="$1.00" />)).toContain(
      "bg-you-fill",
    );
  });

  it("banners: crash is an alert in error, offline is dashed, checkpoint is you tint", () => {
    expect(html(<Banner tone="crash" title="Agent process killed" />)).toContain('role="alert"');
    expect(html(<Banner tone="offline" title="Reconnecting…" />)).toContain("border-dashed");
    expect(html(<Banner tone="checkpoint" title="Files differ from this point" />)).toContain("bg-you-tint");
  });

  it("an empty state is a dashed frame with one purpose and one action", () => {
    const empty = html(
      <EmptyState
        title="No agent yet"
        purpose="An agent has its own thread."
        action={<button type="button">Create</button>}
      />,
    );
    expect(empty).toContain("border-dashed");
    expect(empty).toContain("<h2");
  });

  it("an open tab is a tab with an agent border when active and a labelled close button", () => {
    const tab = html(
      <OpenTab
        tabId="t1"
        title="feat/checkpoints"
        active
        status="running"
        closeLabel="Close feat/checkpoints"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('aria-selected="true"');
    expect(tab).toContain("border-agent");
    expect(tab).toContain('aria-label="Close feat/checkpoints"');
  });

  it("closes a focused tab with Delete, and only with Delete (WAI-ARIA tabs pattern)", async () => {
    const onClose = vi.fn();
    const page = await mount(
      <OpenTab tabId="t2" title="a" active closeLabel="Close a" onSelect={() => {}} onClose={onClose} />,
    );
    const tab = page.container.querySelector('[role="tab"]') as HTMLElement;
    await press(tab, { key: "Enter" });
    await press(tab, { key: "Delete" });
    expect(onClose).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("meters report a value clamped to their range", () => {
    expect(html(<Meter label="Cost today" value={9} max={4} kind="cost" valueText="$9.00" />)).toContain(
      'aria-valuenow="4"',
    );
  });
});

describe("fix round 1 (focus, touch, clamping, guards)", () => {
  it("the focusable tab button shows the focus ring and keeps the 44 px coarse target", async () => {
    const page = await mount(
      <OpenTab tabId="t3" title="b" active closeLabel="Close b" onSelect={() => {}} onClose={() => {}} />,
    );
    const tab = page.container.querySelector('[role="tab"]') as HTMLElement;
    expect(tab.className).toContain("focus-ring");
    expect(tab.className).not.toContain("outline-none");
    expect(tab.className).toContain("pointer-coarse:min-h-11");
    const close = page.container.querySelector('[aria-label="Close b"]') as HTMLElement;
    expect(close.className).toContain("focus-ring");
    await page.unmount();
  });

  it("meters never report NaN or a negative value for a degenerate max", () => {
    const zero = html(<Meter label="Zero" value={5} max={0} kind="tokens" valueText="5" />);
    expect(zero).toContain('aria-valuemax="0"');
    expect(zero).toContain('aria-valuenow="0"');
    const negative = html(<Meter label="Negative" value={3} max={-5} kind="tokens" valueText="3" />);
    expect(negative).toContain('aria-valuemax="0"');
    expect(negative).toContain('aria-valuenow="0"');
    const notANumber = html(<Meter label="NaN" value={3} max={Number.NaN} kind="tokens" valueText="3" />);
    expect(notANumber).toContain('aria-valuemax="0"');
    expect(notANumber).toContain('aria-valuenow="0"');
    expect(html(<Meter label="Mid" value={1} max={4} kind="tokens" valueText="1" />)).toContain(
      'aria-valuenow="1"',
    );
  });

  it("badges show a whole non-negative count, capped at 99+", () => {
    const shown = (count: number) => html(<Badge count={count} label="n" />);
    expect(shown(Number.NaN)).toContain('aria-hidden="true">0</span>');
    expect(shown(-3)).toContain('aria-hidden="true">0</span>');
    expect(shown(2.7)).toContain('aria-hidden="true">2</span>');
    expect(shown(99)).toContain('aria-hidden="true">99</span>');
    expect(shown(100)).toContain('aria-hidden="true">99+</span>');
  });

  it("avatars show a count badge only above zero", () => {
    const withBadge = html(<Avatar initials="AT" name="Atlas" badge={{ count: 2, label: "2 unread" }} />);
    expect(withBadge).toContain('data-slot="badge"');
    const zero = html(<Avatar initials="AT" name="Atlas" badge={{ count: 0, label: "0 unread" }} />);
    expect(zero).not.toContain('data-slot="badge"');
  });

  it("avatar initials keep whole code points", () => {
    expect(html(<Avatar initials="😀😀X" name="Emoji" />)).toContain('aria-hidden="true">😀😀</span>');
  });
});

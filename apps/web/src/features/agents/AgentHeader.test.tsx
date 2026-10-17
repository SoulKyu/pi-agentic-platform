// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../../testing/dom.ts";
import { AgentHeader, type AgentHeaderProps } from "./AgentHeader.tsx";

const atlas: AgentSummary = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};
const show = (extra: Partial<AgentHeaderProps> = {}) =>
  mount(
    <AgentHeader
      agent={atlas}
      view={null}
      avatarStyle="outlined"
      tainted={false}
      pausing={null}
      canReset
      problem={null}
      confirm={null}
      onTogglePause={() => {}}
      onReset={() => {}}
      onOpenSettings={() => {}}
      onQuarantine={() => {}}
      onDelete={() => {}}
      {...extra}
    />,
  );

describe("the header's Queue task (fix round 1, I1)", () => {
  it("is disabled while no handler is given, like Provide… without a dialog", async () => {
    const page = await show();
    expect(button(page.container, "Queue task").disabled).toBe(true);
  });

  it("calls the handler on a click", async () => {
    const onQueueTask = vi.fn();
    const page = await show({ onQueueTask });
    const queue = button(page.container, "Queue task");
    expect(queue.disabled).toBe(false);
    await click(queue);
    expect(onQueueTask).toHaveBeenCalledTimes(1);
  });
});

describe("the header's Resume for a quarantined agent (W5-R58)", () => {
  const quarantined = { ...atlas, paused: true, quarantined: true, state: "quarantined" as const };

  it("is disabled and says where Resume lives, without a native title", async () => {
    const page = await show({ agent: quarantined });
    const resume = button(page.container, "Resume");
    expect(resume.disabled).toBe(true);
    expect(resume.hasAttribute("title")).toBe(false);
    expect(page.container.textContent).toContain("Resume it from its Settings tab");
  });

  it("shows no hint while Resume works", async () => {
    const page = await show({ agent: { ...atlas, paused: true, state: "paused" } });
    expect(page.container.textContent).not.toContain("Settings tab");
  });
});

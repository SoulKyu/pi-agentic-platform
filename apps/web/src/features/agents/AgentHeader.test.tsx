// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
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

describe("the header's cost today (board 12, decision 32)", () => {
  const line = (page: { container: HTMLElement }) =>
    page.container.querySelector("header p")?.textContent ?? "";

  it("adds today's cost to the role line, in the account's language", async () => {
    const view = {
      input: { role: "Keeps the lights on", model: null },
    } as unknown as AgentHeaderProps["view"];
    expect(line(await show({ view, costToday: 1.84 }))).toBe(
      "Keeps the lights on · default model · $1.84 today",
    );
    setLocale("fr");
    try {
      expect(line(await show({ view, costToday: 1.84 }))).toContain("$1.84 aujourd'hui");
    } finally {
      setLocale("en");
    }
  });

  it("says nothing of it until the figure is read", async () => {
    const view = {
      input: { role: "Keeps the lights on", model: null },
    } as unknown as AgentHeaderProps["view"];
    expect(line(await show({ view, costToday: null }))).not.toContain("today");
    expect(line(await show({ view }))).not.toContain("today");
  });
});

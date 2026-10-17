// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { PromptChips } from "./PromptChips.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.prompts"] = () => ({ names: ["weekly-review", "triage"] });
  bed.handlers["agents.prompt"] = (params) => ({
    text: `text of ${(params as { name: string }).name}\u202e hidden`,
  });
  useComposerPrefill.setState({ items: {} });
});
const show = async (stamp = "1") => {
  const page = await mount(<PromptChips agentId="atlas-1a2b" sessionId="s1" refreshKey={stamp} />);
  await settle();
  return page;
};

describe("the prompt chips (M11R122)", () => {
  it("draws one chip per name the agent's home lists", async () => {
    const page = await show();
    expect(bed.called("agents.prompts")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
    expect(hasButton(page.container, "weekly-review")).toBe(true);
    expect(hasButton(page.container, "triage")).toBe(true);
  });

  it("draws nothing when the home has no prompt", async () => {
    bed.handlers["agents.prompts"] = () => ({ names: [] });
    const page = await show();
    expect(text(page.container)).toBe("");
  });

  it("fills the composer on a click and sends nothing", async () => {
    const page = await show();
    await click(button(page.container, "triage"));
    await settle();
    expect(bed.called("agents.prompt")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b", name: "triage" } }),
    ]);
    expect(useComposerPrefill.getState().items["s1"]?.text).toBe("text of triage hidden");
    expect(bed.called("sessions.prompt")).toEqual([]);
    expect(bed.called("agents.queueTask")).toEqual([]);
  });

  it("shows the chip name as text, hidden characters removed", async () => {
    bed.handlers["agents.prompts"] = () => ({ names: ["a\u202eb"] });
    const page = await show();
    expect(hasButton(page.container, "ab")).toBe(true);
  });

  it("says so when a prompt cannot be read, and fills nothing", async () => {
    bed.handlers["agents.prompt"] = () => {
      throw new RpcError("not_found");
    };
    const page = await show();
    await click(button(page.container, "triage"));
    await settle();
    expect(alerts(page.container)).not.toEqual([]);
    expect(useComposerPrefill.getState().items["s1"]).toBeUndefined();
  });

  it("reads the names again when the key moves, once the activity has been quiet for a second", async () => {
    const page = await show("1");
    bed.handlers["agents.prompts"] = () => ({ names: ["new-one"] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => {
        await page.rerender(<PromptChips agentId="atlas-1a2b" sessionId="s1" refreshKey="2" />);
      });
      expect(hasButton(page.container, "triage")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(hasButton(page.container, "new-one")).toBe(true);
    expect(hasButton(page.container, "triage")).toBe(false);
  });

  it("gives five activity ticks in a second one read", async () => {
    const page = await show("1");
    expect(bed.called("agents.prompts")).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const tick of ["2", "3", "4", "5", "6"]) {
        await act(async () => {
          await page.rerender(<PromptChips agentId="atlas-1a2b" sessionId="s1" refreshKey={tick} />);
          await vi.advanceTimersByTimeAsync(200);
        });
      }
      expect(bed.called("agents.prompts")).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(bed.called("agents.prompts")).toHaveLength(2);
  });

  it("reads at once for another agent", async () => {
    const page = await show("1");
    await act(async () => {
      await page.rerender(<PromptChips agentId="other-3c4d" sessionId="s1" refreshKey="1" />);
    });
    await settle();
    expect(bed.called("agents.prompts")).toHaveLength(2);
  });
});

// @vitest-environment happy-dom
import type { SessionCost, SessionLoadout } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { toMessageView } from "../../stores/row-view.ts";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import { mount, text } from "../../testing/dom.ts";
import { UsageLine } from "./UsageLine.tsx";

const loadout = (contextWindow: number): SessionLoadout => ({
  model: { provider: "p", id: "m", name: "M", reasoning: false, contextWindow },
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: [],
  toolsTruncated: false,
});
const reply = (totalTokens: number) =>
  toMessageView({
    role: "assistant",
    content: "x",
    timestamp: 1,
    stopReason: "stop",
    usage: { totalTokens },
  });
const cost = (patch: Partial<SessionCost> = {}): SessionCost => ({
  sessionUsd: 0.42,
  runUsd: 0.05,
  billing: "api",
  ...patch,
});
const viewOf = (used: number | null, c: SessionCost | null): SessionView => ({
  ...EMPTY_VIEW,
  loadout: loadout(200_000),
  messages: used === null ? [] : [reply(used) ?? never()],
  cost: c,
});
const never = (): never => {
  throw new Error("no message");
};

afterEach(() => setLocale("en"));

describe("UsageLine", () => {
  it("renders 41K / 200K tokens, a meter with aria-valuenow 41000 and aria-valuemax 200000, and Session $0.42 · run $0.05", async () => {
    const { container } = await mount(<UsageLine view={viewOf(41_000, cost())} />);
    const root = container.querySelector("[data-usage-line]");
    expect(root).not.toBeNull();
    expect(text(container)).toContain("41K / 200K tokens");
    const meter = container.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("41000");
    expect(meter?.getAttribute("aria-valuemax")).toBe("200000");
    expect(meter?.getAttribute("aria-label")).toBe("Context");
    expect(text(container)).toContain("Session $0.42 · run $0.05");
    expect(text(container)).not.toContain("compaction soon");
    expect(root?.getAttribute("aria-live")).toBeNull();
  });

  it("at 85 % the bar takes the attention fill and the line says compaction soon", async () => {
    const { container } = await mount(<UsageLine view={viewOf(170_000, cost({ runUsd: null }))} />);
    expect(text(container)).toContain("compaction soon");
    expect(container.querySelector('[role="meter"] > div')?.className).toContain("bg-attn-fill");
    expect(text(container)).toContain("Session $0.42");
    expect(text(container)).not.toContain("run $");
    const calm = await mount(<UsageLine view={viewOf(41_000, null)} />);
    expect(calm.container.querySelector('[role="meter"] > div')?.className).toContain("bg-agent-fill");
  });

  it("with neither figure nothing renders", async () => {
    const { container } = await mount(<UsageLine view={viewOf(null, null)} />);
    expect(container.querySelector("[data-usage-line]")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("in French it says jetons and équivalent API", async () => {
    setLocale("fr");
    const { container } = await mount(<UsageLine view={viewOf(41_000, cost({ billing: "subscription" }))} />);
    expect(text(container)).toContain("jetons");
    expect(text(container)).toContain("équivalent API");
    expect(text(container)).toContain("exécution");
  });
});

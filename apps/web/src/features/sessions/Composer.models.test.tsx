// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, hasButton } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const { show } = screenBed(current);
const loadout = {
  model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
  thinkingLevel: "high",
  levels: ["off", "high"],
  preset: "configured",
  tools: [],
  toolsTruncated: false,
};

describe("Composer model bar", () => {
  it("shows the session's model and level beside the send button, and keeps Send working", async () => {
    const container = await show({ status: "idle", loadout });
    expect(button(container, "anthropic · claude-sonnet-4")).toBeTruthy();
    expect(button(container, "thinking: high")).toBeTruthy();
    expect(hasButton(container, "Send")).toBe(true);
  });

  it("renders for a cold session (no loadout): a model button and no reasoning button", async () => {
    const container = await show({ status: "idle", loadout: null });
    expect(button(container, "Choose a model")).toBeTruthy();
    expect(hasButton(container, "Send")).toBe(true);
    expect(
      [...container.querySelectorAll("button")].some((one) => /thinking/.test(one.textContent ?? "")),
    ).toBe(false);
  });

  it("disables the model pill while the agent works, and says why", async () => {
    const container = await show({ status: "running", loadout });
    expect(button(container, "anthropic · claude-sonnet-4").disabled).toBe(true);
    expect(container.textContent).toContain("Change the model when the agent is idle");
  });
});

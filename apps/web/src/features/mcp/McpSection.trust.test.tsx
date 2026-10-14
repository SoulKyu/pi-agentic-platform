// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { StepUpContext } from "../../lib/step-up-context.tsx";
import { mount } from "../../testing/dom.ts";
import { current, newBed, overviewOf, stepUp } from "./mcp-bed.tsx";
import { McpSection } from "./McpSection.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// The trust dialog asks the shell's runner through the context (MC49).
const show = () =>
  mount(
    <StepUpContext.Provider value={stepUp}>
      <McpSection stepUp={stepUp} cwd="/work/app" />
    </StepUpContext.Provider>,
  );

const untrusted = () =>
  overviewOf({ project: { path: "/work/app/.pi/mcp.json", problem: null, trusted: false, servers: [] } });

describe("Settings › MCP trust notice (Task 23)", () => {
  it("offers Review next to the untrusted notice, and Review opens the trust dialog", async () => {
    const bed = newBed(untrusted());
    bed.handlers["trust.status"] = () => ({
      requiresTrust: true,
      decision: null,
      decisionPath: null,
      inherited: false,
      resources: {
        mcpServers: [],
        extensions: ["deploy.ts"],
        skills: [],
        promptTemplates: 0,
        settingsKeys: [],
        systemPrompt: false,
        truncated: false,
        unlisted: [],
      },
    });
    const page = await show();
    await settle();
    await click(button(page.container, "Review"));
    await vi.waitFor(() => expect(text(document.body)).toContain("deploy.ts"), { timeout: 4000 });
    expect(bed.called("trust.status")[0]?.params).toEqual({ cwd: "/work/app" });
  });

  it("offers no Review when the project is trusted", async () => {
    newBed();
    const page = await show();
    await settle();
    expect(hasButton(page.container, "Review")).toBe(false);
  });
});

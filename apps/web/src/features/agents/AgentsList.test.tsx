// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../../testing/dom.ts";
import { EMPTY_AGENTS } from "../../stores/agents-reducer.ts";
import { AgentsList } from "./AgentsList.tsx";

describe("AgentsList: failures", () => {
  it("an agent list load failure is a status", async () => {
    const page = await mount(
      <AgentsList
        view={{ ...EMPTY_AGENTS, failed: "internal" }}
        avatarStyle="outlined"
        onOpen={() => undefined}
        onNew={() => undefined}
      />,
    );
    const failure = page.container.querySelector('[data-slot="inline-error"]');
    expect(failure?.getAttribute("role")).toBe("status");
    expect(failure?.className).toContain("text-err");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });
});

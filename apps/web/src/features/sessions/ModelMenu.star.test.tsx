// @vitest-environment happy-dom
import type { AvailableModelsData, ModelsOverview } from "@pap/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ModelBar } from "./ModelBar.tsx";

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
  };
});

const SONNET = { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true };
const available: AvailableModelsData = {
  models: [SONNET, OPUS],
  truncated: false,
  current: { provider: SONNET.provider, id: SONNET.id },
};
const overview: ModelsOverview = {
  providers: [],
  defaults: { provider: "anthropic", model: "claude-opus-4", thinkingLevel: null },
  enabled: { patterns: null, scope: "global", settingsPath: "/x/settings.json", warnings: [] },
  offline: false,
  truncated: false,
};

beforeAll(async () => {
  await import("./ModelMenu.tsx");
}, 60_000);
beforeEach(() => {
  const bed = fakeRuntime();
  bed.handlers["sessions.models"] = () => available;
  bed.handlers["models.overview"] = () => overview;
  current.runtime = bed.runtime;
});

describe("ModelMenu default star", () => {
  it("the default model's star is a filled Star in a 24 px button", async () => {
    const page = await mount(
      <ModelBar
        sessionId="sess-1"
        loadout={{
          model: SONNET,
          thinkingLevel: "high",
          levels: ["off", "high"],
          preset: "configured",
          tools: [],
          toolsTruncated: false,
        }}
        running={false}
      />,
    );
    await click(button(page.container, "anthropic · claude-sonnet-4"));
    await act(async () => {
      await vi.waitFor(
        () => expect(document.querySelectorAll("[data-model-row]").length).toBeGreaterThan(0),
        {
          timeout: 10_000,
        },
      );
    });
    const star = button(document.body, "Make Claude Opus 4 the default");
    const other = button(document.body, "Make Claude Sonnet 4 the default");
    expect(star.className).toContain("size-6");
    expect(star.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    expect(other.querySelector("svg")?.getAttribute("fill")).toBe("none");
  });
});

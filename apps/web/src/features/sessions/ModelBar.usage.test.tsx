// @vitest-environment happy-dom
import type { SessionLoadout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ModelBar } from "./ModelBar.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const loadout: SessionLoadout = {
  model: { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet", reasoning: true },
  thinkingLevel: "high",
  levels: ["off", "high"],
  preset: "configured",
  tools: [],
  toolsTruncated: false,
};

beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
});
afterEach(() => setLocale("en"));

describe("ModelBar after slot", () => {
  it("the usage line sits in the model bar after the pills", async () => {
    const { container } = await mount(
      <ModelBar
        sessionId="s"
        loadout={loadout}
        running={false}
        after={<span data-usage-line>Session $0.42</span>}
      />,
    );
    const row = container.querySelector("[data-model-bar] > div");
    const last = row?.lastElementChild;
    expect(last?.hasAttribute("data-usage-line")).toBe(true);
    const pills = [...(row?.querySelectorAll("button") ?? [])];
    expect(pills.length).toBeGreaterThanOrEqual(2);
    for (const pill of pills)
      expect(Boolean(pill.compareDocumentPosition(last as Element) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
        true,
      );
  });
});

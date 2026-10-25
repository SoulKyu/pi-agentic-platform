// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { RoleContext } from "../../../lib/role-context.ts";
import type { Runtime } from "../../../runtime/index.ts";
import { mount, settle } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { useAvailableModels, type AvailableState } from "./use-available-models.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

describe("the picker as a member", () => {
  it("lists models through sessions.availableModels, with no folder", async () => {
    const bed = fakeRuntime("open");
    current.runtime = bed.runtime;
    bed.handlers["sessions.availableModels"] = () => ({
      models: [{ provider: "mine", id: "a", name: "A", reasoning: false }],
      providers: [{ id: "mine", name: "Mine" }],
      origin: "signed-in",
      truncated: false,
    });
    const seen: { state: AvailableState } = { state: { status: "loading" } };
    function Probe() {
      seen.state = useAvailableModels("/boxes/p/project", true);
      return null;
    }
    await mount(
      <RoleContext.Provider value="member">
        <Probe />
      </RoleContext.Provider>,
    );
    await settle();
    expect(bed.called("sessions.availableModels").map((call) => call.params)).toEqual([{}]);
    expect(bed.called("models.available")).toEqual([]);
    expect(seen.state.status).toBe("ready");
  });
});

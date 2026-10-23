// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { NewAgentEntry } from "./new-agent-entry.tsx";

const current: { runtime: Runtime | undefined } = { runtime: undefined };
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

describe("the New agent dialog of the shell", () => {
  it("shows the form, with no sandbox read of its own", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    await mount(
      <TooltipProvider>
        <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
          <NewAgentEntry onClose={vi.fn()} onCreated={vi.fn()} />
        </StepUpContext.Provider>
      </TooltipProvider>,
    );
    await settle();
    await settle();
    expect(document.querySelector("form")).not.toBeNull();
  });
});

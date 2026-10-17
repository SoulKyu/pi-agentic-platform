// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { NewAgentEntry } from "./new-agent-entry.tsx";

const current: { runtime: Runtime | undefined } = { runtime: undefined };
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const usable = { usable: true, path: "/usr/bin/bwrap", reason: null, checkedAt: 5 };

async function open(recheck: () => unknown) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["agents.sandboxStatus"] = () => {
    throw new RpcError("internal");
  };
  bed.handlers["agents.recheckSandbox"] = recheck;
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <NewAgentEntry onClose={vi.fn()} onCreated={vi.fn()} />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  await settle();
  return bed;
}

describe("the New agent dialog when the sandbox read fails", () => {
  it("says so and offers Check again, which brings the form once the check answers", async () => {
    const bed = await open(() => usable);
    expect(text(document.body)).toContain("The sandbox state could not be read.");
    expect(document.querySelector("form")).toBeNull();
    await click(button(document.body, "Check again"));
    await settle();
    await settle();
    expect(bed.called("agents.recheckSandbox")).toHaveLength(1);
    expect(text(document.body)).not.toContain("The sandbox state could not be read.");
    expect(document.querySelector("form")).not.toBeNull();
  });

  it("says when the check itself could not run, and stays on the message", async () => {
    await open(() => {
      throw new RpcError("internal");
    });
    await click(button(document.body, "Check again"));
    await settle();
    expect(text(document.body)).toContain("The check could not run. Try again.");
    expect(document.querySelector("form")).toBeNull();
  });
});

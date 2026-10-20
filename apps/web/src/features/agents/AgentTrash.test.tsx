// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentTrash } from "./AgentTrash.tsx";

/*
 * Mutants (RT-43), run for real: the entry is not rendered after a read (the list is dropped) -> "lists the deleted agents"
 * fails; the purge skips the step-up runner -> "purges through the step-up" fails; the entry stays after a purge -> "drops
 * the entry once it is purged" fails.
 */
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: toasts,
}));

let bed: ReturnType<typeof fakeRuntime>;
let stepUp: ReturnType<typeof vi.fn>;
const entry = (agentId: string, name: string) => ({ agentId, name, deletedAt: 1_700_000_000_000 });

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.trash"] = () => ({
    agents: [entry("atlas-1a2b", "Atlas"), entry("borea-3c4d", "Borea")],
  });
  bed.handlers["agents.purgeTrash"] = () => ({ ok: true });
  stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-0003"));
  toasts.mockReset();
});
afterEach(() => setLocale("en"));

const show = async () => {
  await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <AgentTrash />
    </StepUpContext.Provider>,
  );
  await settle();
};
const body = () => document.body.textContent ?? "";

describe("the trash entry of deleted VM agents (J1b)", () => {
  it("lists the deleted agents, each with its own Purge now", async () => {
    await show();
    expect(body()).toContain("Atlas");
    expect(body()).toContain("Borea");
    expect(hasButton(document.body, "Purge Atlas's trash now")).toBe(true);
    expect(hasButton(document.body, "Purge Borea's trash now")).toBe(true);
  });

  it("purges that agent through the step-up, tells the owner, and drops the entry once it is purged", async () => {
    await show();
    await click(button(document.body, "Purge Atlas's trash now"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.purgeTrash")).toEqual([
      expect.objectContaining({
        params: { agentId: "atlas-1a2b" },
        options: expect.objectContaining({ commandId: "step-cmd-0003" }),
      }),
    ]);
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ message: "Atlas's trash is empty." }));
    expect(body()).not.toContain("Atlas");
    expect(body()).toContain("Borea");
  });

  it("keeps the entry when the password prompt is cancelled or the purge is refused", async () => {
    stepUp.mockResolvedValueOnce(null);
    await show();
    await click(button(document.body, "Purge Atlas's trash now"));
    await settle();
    expect(bed.called("agents.purgeTrash")).toEqual([]);
    expect(body()).toContain("Atlas");
    bed.handlers["agents.purgeTrash"] = () => {
      throw new RpcError("sandbox_unavailable");
    };
    await click(button(document.body, "Purge Atlas's trash now"));
    await settle();
    expect(body()).toContain("Atlas");
    expect(toasts).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the trash is empty or cannot be read", async () => {
    bed.handlers["agents.trash"] = () => ({ agents: [] });
    await show();
    expect(body()).toBe("");
  });

  it("shows nothing when the read fails", async () => {
    bed.handlers["agents.trash"] = () => {
      throw new RpcError("internal");
    };
    await show();
    expect(body()).toBe("");
  });
});

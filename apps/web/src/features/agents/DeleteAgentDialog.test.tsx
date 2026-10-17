// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { DeleteAgentDialog } from "./DeleteAgentDialog.tsx";

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
const onClose = vi.fn();

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.delete"] = () => ({ trashedAs: "atlas-1a2b-1700000000" });
  stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-0002"));
  onClose.mockReset();
  toasts.mockReset();
});
afterEach(() => setLocale("en"));

const show = async () => {
  await mount(
    <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
      <DeleteAgentDialog agent={{ id: "atlas-1a2b", name: "Atlas" }} onClose={onClose} />
    </StepUpContext.Provider>,
  );
  await settle();
};
const body = () => document.body.textContent ?? "";

describe("deleting an agent (M11R126)", () => {
  it("says where the home goes and what is deleted, before asking for anything", async () => {
    await show();
    expect(body()).toContain("Delete Atlas?");
    expect(body()).toContain("The home and its tasks' scratch folders go to .trash");
    expect(body()).toContain("its triggers and secrets are deleted");
    expect(stepUp).not.toHaveBeenCalled();
    expect(bed.called("agents.delete")).toEqual([]);
  });

  it("deletes through the step-up and closes with a note", async () => {
    await show();
    await click(button(document.body, "Delete Atlas"));
    await settle();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.delete")).toEqual([
      expect.objectContaining({
        params: { agentId: "atlas-1a2b" },
        options: expect.objectContaining({ commandId: "step-cmd-0002" }),
      }),
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Atlas") }),
    );
  });

  it("stays open, with no error, when the password prompt is cancelled", async () => {
    stepUp.mockResolvedValue(null);
    await show();
    await click(button(document.body, "Delete Atlas"));
    await settle();
    expect(bed.called("agents.delete")).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(alerts(document.body)).toEqual([]);
  });

  it("says a task is still running when the session is busy", async () => {
    bed.handlers["agents.delete"] = () => {
      throw new RpcError("session_busy");
    };
    await show();
    await click(button(document.body, "Delete Atlas"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain("working");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says the home was moved but a later step failed, and that asking again finishes it", async () => {
    bed.handlers["agents.delete"] = () => {
      throw new RpcError("command_failed");
    };
    await show();
    await click(button(document.body, "Delete Atlas"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain("stays quarantined");
    expect(hasButton(document.body, "Delete Atlas")).toBe(true);
  });

  it("closes on Cancel", async () => {
    await show();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bed.called("agents.delete")).toEqual([]);
  });
});

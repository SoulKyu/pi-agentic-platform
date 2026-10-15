// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { current, newBed, NOW, showWithStepUp, taskOf } from "./board-bed.tsx";
import { TaskCard } from "./TaskCard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => setLocale("en"));

const chip = async (patch: Parameters<typeof taskOf>[0]) => {
  newBed();
  const page = await showWithStepUp(
    <ul>
      <TaskCard task={taskOf(patch)} now={NOW} current={false} onOpenSession={() => {}} />
    </ul>,
  );
  return (page.container.querySelector('[data-slot="chip"]') ?? page.container).textContent ?? "";
};

describe("TaskCard reason", () => {
  it.each([
    ["failed", "budget", "Failed · budget"],
    ["failed", "run_budget", "Failed · run budget"],
    ["failed", "deadline", "Failed · deadline"],
    ["failed", "provider", "Failed · provider"],
    ["failed", "prompt_rejected", "Failed · prompt refused"],
    ["interrupted", "crash", "Interrupted · crash"],
    ["cancelled", "stopped", "Cancelled · stopped"],
    ["cancelled", "archived", "Cancelled · archived"],
  ] as const)("a %s task with reason %s reads %s", async (state, reason, words) => {
    expect(await chip({ state, reason })).toContain(words);
  });

  it("says the reason in French", async () => {
    setLocale("fr");
    expect(await chip({ state: "failed", reason: "budget" })).toContain("Échec · budget");
  });

  it("writes an unknown reason out, hidden characters included", async () => {
    const shown = await chip({ state: "failed", reason: "odd‮code" });
    expect(shown).toContain("Failed · odd\\u202Ecode");
  });

  it("shows nothing extra without a reason, nor for a plain cancel", async () => {
    expect(await chip({ state: "failed", reason: null })).toBe("Failed");
    expect(await chip({ state: "cancelled", reason: "cancelled" })).toBe("Cancelled");
  });
});

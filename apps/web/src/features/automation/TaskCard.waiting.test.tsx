// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { current, newBed, NOW, showWithStepUp, taskOf } from "./board-bed.tsx";
import { TaskCard } from "./TaskCard.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const words = async (patch: Parameters<typeof taskOf>[0]) => {
  newBed();
  const page = await showWithStepUp(
    <ul>
      <TaskCard task={taskOf(patch)} now={NOW} current={false} onOpenSession={() => {}} />
    </ul>,
  );
  return page.container.querySelector("[data-waiting]")?.textContent ?? null;
};

describe("TaskCard waiting", () => {
  it("a deferred task says it waits for a session slot, 4/4, with its next try", async () => {
    const said = await words({
      state: "queued",
      waiting: { reason: "session_slots", used: 4, max: 4, nextTryAt: NOW + 8000 },
    });
    expect(said).toBe("Waiting for a session slot · 4/4 in use · Next try in 8 s");
  });

  it("omits the count and the position when the daemon sends none", async () => {
    expect(await words({ state: "queued", waiting: { reason: "session_slots" } })).toBe(
      "Waiting for a session slot",
    );
    expect(await words({ state: "queued", waiting: { reason: "image_build" } })).toBe(
      "Waiting for another image build",
    );
  });

  it("says it in French, and nothing for a task that waits for nothing", async () => {
    setLocale("fr");
    expect(await words({ state: "queued", waiting: { reason: "image_build", position: 2 } })).toBe(
      "En attente d'une autre construction d'image · 2 dans la file",
    );
    setLocale("en");
    expect(await words({ state: "queued", waiting: null })).toBeNull();
  });
});

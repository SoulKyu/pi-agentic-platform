// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import { FailuresBanner } from "./FailuresBanner.tsx";
import { current, failureOf, newBed, NOW, showWithStepUp } from "./board-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

describe("FailuresBanner", () => {
  it("shows nothing without a failure", async () => {
    newBed();
    const page = await showWithStepUp(<FailuresBanner failures={[]} now={NOW} />);
    expect(page.container.querySelector('[data-slot="banner"]')).toBeNull();
  });

  it("is a neutral banner that counts the jobs and lists kind, time and code", async () => {
    newBed();
    const page = await showWithStepUp(
      <FailuresBanner
        failures={[failureOf(), failureOf({ id: 8, kind: "push", lastError: null })]}
        now={NOW}
      />,
    );
    const banner = page.container.querySelector('[data-slot="banner"]') as HTMLElement;
    expect(banner.getAttribute("data-tone")).toBe("capacity");
    expect(banner.getAttribute("role")).toBe("status");
    expect(text(banner)).toContain("2 background jobs failed");
    expect(text(banner)).toContain("run.resume · 5 min · worker_failed");
    expect(text(banner)).toContain("push · 5 min · no code");
  });

  it("says one job in the singular", async () => {
    newBed();
    const page = await showWithStepUp(<FailuresBanner failures={[failureOf()]} now={NOW} />);
    expect(text(page.container)).toContain("1 background job failed");
  });

  it("Dismiss calls automation.failures.dismiss with a commandId", async () => {
    const bed = newBed();
    const page = await showWithStepUp(<FailuresBanner failures={[failureOf()]} now={NOW} />);
    await click(button(page.container, "Dismiss"));
    await settle();
    const [call] = bed.called("automation.failures.dismiss");
    expect(call?.params).toEqual({ effectId: 7 });
    expect(call?.options?.commandId).toBeTruthy();
  });

  it("says in plain words when the job was already dismissed", async () => {
    const bed = newBed();
    bed.handlers["automation.failures.dismiss"] = () => {
      throw new RpcError("not_found");
    };
    const page = await showWithStepUp(<FailuresBanner failures={[failureOf()]} now={NOW} />);
    await click(button(page.container, "Dismiss"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("already dismissed");
  });
});

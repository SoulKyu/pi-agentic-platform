import { describe, expect, it, vi } from "vitest";
import { imageStep } from "./launches.ts";

describe("imageStep", () => {
  it("an observer line becomes the running image step's last sign of life", async () => {
    const step = vi.fn();
    await imageStep({ step, wait: vi.fn() }, async (observe) => {
      observe?.line?.("#4 RUN apt-get update", 1234);
    });
    expect(step).toHaveBeenCalledWith("image", "running", { line: "#4 RUN apt-get update", at: 1234 });
    expect(step).toHaveBeenLastCalledWith("image", "done");
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { loadBehavior, planSend, restoreCleared, saveBehavior, stopSession } from "./composer.vm.ts";

beforeEach(() => localStorage.clear());

describe("composer view-model", () => {
  it("plans a send with the preferred behaviour, as typed, nothing for blank text (M2-RT-36)", () => {
    expect(planSend("  go  ", "followUp")).toEqual({ text: "  go", streamingBehavior: "followUp" });
    expect(planSend("    const x = 1;\n", "steer")).toEqual({
      text: "    const x = 1;",
      streamingBehavior: "steer",
    });
    expect(planSend(" \n ", "steer")).toBeNull();
  });

  it("defaults to steer and remembers the choice per device", () => {
    expect(loadBehavior(localStorage)).toBe("steer");
    saveBehavior(localStorage, "followUp");
    expect(loadBehavior(localStorage)).toBe("followUp");
    localStorage.setItem("pap.sessions.streaming", "nonsense");
    expect(loadBehavior(localStorage)).toBe("steer");
    expect(loadBehavior(null)).toBe("steer");
  });

  it("restores cleared steering and follow-ups before the current text", () => {
    expect(restoreCleared({ steering: ["left"], followUp: ["then"] }, "now")).toBe("left\n\nthen\n\nnow");
    expect(restoreCleared({ steering: [], followUp: [] }, "now")).toBe("now");
  });
});

describe("stopSession", () => {
  const names = (bed: ReturnType<typeof fakeRuntime>) =>
    bed.calls.map((call) => call.method).filter((method) => method !== "subscribe.session");

  it("sends clearQueue and abort back to back, before either has answered (M2R122)", async () => {
    const bed = fakeRuntime();
    bed.handlers["sessions.clearQueue"] = () => new Promise(() => {});
    void stopSession(bed.runtime, "s1");
    expect(names(bed)).toEqual(["sessions.clearQueue", "sessions.abort"]);
  });

  it("returns what was cleared, and hands it over even when the abort fails", async () => {
    const bed = fakeRuntime();
    bed.handlers["sessions.clearQueue"] = () => ({ steering: ["a"], followUp: ["b"], truncated: false });
    expect(await stopSession(bed.runtime, "s1")).toEqual({ steering: ["a"], followUp: ["b"] });
    bed.handlers["sessions.abort"] = () => {
      throw new RpcError("worker_failed");
    };
    const restored = vi.fn();
    await expect(stopSession(bed.runtime, "s1", restored)).rejects.toMatchObject({ code: "worker_failed" });
    expect(restored).toHaveBeenCalledWith({ steering: ["a"], followUp: ["b"] });
  });

  it("aborts anyway, and rejects with nothing, when only clearQueue fails", async () => {
    const bed = fakeRuntime();
    bed.handlers["sessions.clearQueue"] = () => {
      throw new RpcError("timeout");
    };
    const restored = vi.fn();
    expect(await stopSession(bed.runtime, "s1", restored)).toEqual({ steering: [], followUp: [] });
    expect(names(bed)).toEqual(["sessions.clearQueue", "sessions.abort"]);
    expect(restored).not.toHaveBeenCalled();
  });
});

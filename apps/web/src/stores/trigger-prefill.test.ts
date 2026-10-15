import { beforeEach, describe, expect, it } from "vitest";
import { useTriggerPrefill } from "./trigger-prefill.ts";

beforeEach(() => useTriggerPrefill.setState({ items: {} }));

describe("the trigger prefill (decision 85)", () => {
  it("waits for its project's editor, is read without being consumed, and goes when dropped", () => {
    useTriggerPrefill.getState().put("p1", { name: "Nightly", prompt: "Report" });
    expect(useTriggerPrefill.getState().peek("p2")).toBeNull();
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "Nightly", prompt: "Report" });
    expect(useTriggerPrefill.getState().peek("p1")).toEqual({ name: "Nightly", prompt: "Report" });
    useTriggerPrefill.getState().drop("p1");
    expect(useTriggerPrefill.getState().peek("p1")).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { appendDraft, MAX_PREFILL_CHARS, useComposerPrefill } from "./composer-prefill.ts";

beforeEach(() => useComposerPrefill.setState({ items: {} }));

describe("composer prefill", () => {
  it("hands a text over once, to the session it was pushed for", () => {
    useComposerPrefill.getState().push("s1", "Review comments");
    expect(useComposerPrefill.getState().take("s2")).toBeNull();
    expect(useComposerPrefill.getState().take("s1")).toBe("Review comments");
    expect(useComposerPrefill.getState().take("s1")).toBeNull();
  });

  it("joins two texts pushed before the composer took them, with a blank line", () => {
    useComposerPrefill.getState().push("s1", "first");
    useComposerPrefill.getState().push("s1", "second");
    expect(useComposerPrefill.getState().take("s1")).toBe("first\n\nsecond");
  });

  it("keeps at most MAX_PREFILL_CHARS of what waits", () => {
    useComposerPrefill.getState().push("s1", "x".repeat(MAX_PREFILL_CHARS + 10));
    expect(useComposerPrefill.getState().take("s1")).toHaveLength(MAX_PREFILL_CHARS);
  });

  it("appends after the draft with a blank line, and never over it", () => {
    expect(appendDraft("half a thought", "batch")).toBe("half a thought\n\nbatch");
    expect(appendDraft("trailing\n", "batch")).toBe("trailing\n\nbatch");
    expect(appendDraft("trailing\n\n", "batch")).toBe("trailing\n\nbatch");
    expect(appendDraft("", "batch")).toBe("batch");
    expect(appendDraft("   \n", "batch")).toBe("batch");
  });
});

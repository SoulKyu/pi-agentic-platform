import { beforeEach, expect, it } from "vitest";
import { useFocusEntry } from "./focus-entry.ts";

beforeEach(() => useFocusEntry.setState({ target: null }));

it("hands the entry over once, to its own session only", () => {
  useFocusEntry.getState().ask({ sessionId: "s1", entryId: "e2" });
  expect(useFocusEntry.getState().take("s2")).toBeNull();
  expect(useFocusEntry.getState().target).toEqual({ sessionId: "s1", entryId: "e2" });
  expect(useFocusEntry.getState().take("s1")).toBe("e2");
  expect(useFocusEntry.getState().take("s1")).toBeNull();
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReplyPorts, type ReplyPort } from "./reply-ports.ts";

const port = (base: string): ReplyPort => ({
  scope: { base, roots: [base], filesRoot: base, agentId: null },
  openFile: vi.fn(),
});

beforeEach(() => useReplyPorts.getState().reset());

describe("reply ports", () => {
  it("register returns a remover that removes only its own port; a newer port of the same session stays", () => {
    const first = port("/a");
    const second = port("/b");
    const removeFirst = useReplyPorts.getState().register("s1", first);
    expect(useReplyPorts.getState().ports["s1"]).toBe(first);
    const removeSecond = useReplyPorts.getState().register("s1", second);
    removeFirst();
    expect(useReplyPorts.getState().ports["s1"]).toBe(second);
    removeSecond();
    expect(useReplyPorts.getState().ports).toEqual({});
  });

  it("reset empties", () => {
    useReplyPorts.getState().register("s1", port("/a"));
    useReplyPorts.getState().register("s2", port("/b"));
    useReplyPorts.getState().reset();
    expect(useReplyPorts.getState().ports).toEqual({});
  });
});

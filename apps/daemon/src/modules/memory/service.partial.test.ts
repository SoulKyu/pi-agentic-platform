import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMem0Layout, type Mem0Layout } from "./testing/layout.ts";

let calls = 0;
vi.mock("./mem0-files.ts", async (original) => ({
  ...(await original<typeof import("./mem0-files.ts")>()),
  requestForget: () => {
    calls += 1;
    if (calls === 2) throw new Error("disk full");
    return "id";
  },
}));
const { createMemoryService } = await import("./service.ts");

let layout: Mem0Layout;
afterEach(() => layout.dispose());

describe("a forget that fails half way (fix round 1)", () => {
  it("audits the requests that were written, and answers command_failed", () => {
    layout = createMem0Layout();
    layout.json("scopes/user.json", {
      memories: [
        { id: "m1", text: "a", createdAt: "", source: "x" },
        { id: "m2", text: "b", createdAt: "", source: "x" },
      ],
    });
    const audit: Array<Record<string, unknown>> = [];
    const service = createMemoryService({
      dir: layout.mem0,
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: false,
      audit: { append: (line) => void audit.push({ ...line }) },
      inbox: { resolveRef: () => true },
      agents: { get: () => null, list: () => [] },
    });
    expect(() => service.forget(testCaller(), { scope: { kind: "user" }, ids: ["m1", "m2"] })).toThrow(
      expect.objectContaining({ code: "command_failed" }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ detail: { scope: "user", op: "forget", count: 1 } });
  });
});

import { type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import type { AgentFilesSource } from "../agent-path.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { httpCaller } from "../http/caller.ts";
import { silentLogger } from "../logger.ts";
import { createFakeProjectBoxSource } from "../testing/fake-boxes.ts";
import { createClientPathGate } from "./client-path-gate.ts";
import { createDispatcher } from "./dispatcher.ts";

const OWN = "/agents/helper-1a2b/home";
const agents: AgentFilesSource = {
  guestRootOf: (owner, id) => (owner === "m1" && id === "helper-1a2b" ? "/agent" : null),
  importedOf: () => [],
};
const receipts: ReceiptStore = { find: () => null, save: () => undefined, purge: () => 0, readOnly: false };
const ctx = (caller: Caller): HandlerContext => ({
  caller,
  connectionId: "c1",
  openSubscription: () => "s1",
  closeSubscription: () => {},
});
const gate = createClientPathGate({
  isMember: (id) => id === "m1",
  boxes: () => createFakeProjectBoxSource({}),
  agents: () => agents,
});

describe("a member's agent path is for the files surface only", () => {
  const handlers = {
    "files.list": vi.fn(async () => ({ entries: [], truncated: false })),
    "sessions.create": vi.fn(async () => ({ sessionId: "s1" })),
    "models.available": vi.fn(async () => ({})),
  } as unknown as HandlerTable;
  const dispatch = createDispatcher({ handlers, receipts, logger: silentLogger, gate });
  const member = ctx(testCaller({ userId: "m1" }));
  const code = async (method: string, params: unknown) => {
    const answer = await dispatch({ id: 1, method, params, commandId: "c" } as never, member);
    return answer.ok ? "ok" : answer.error.code;
  };

  it("allows files.list, refuses sessions.create and models.available", async () => {
    expect(await code("files.list", { path: OWN })).toBe("ok");
    expect(await code("sessions.create", { cwd: OWN })).toBe("forbidden");
    expect(await code("models.available", { cwd: OWN })).toBe("forbidden");
  });

  it("allows the files HTTP routes only", async () => {
    const owner = testCaller({ userId: "m1" });
    const app = new Hono();
    const files = httpCaller(() => owner, gate, "files");
    const other = httpCaller(() => owner, gate);
    for (const [route, caller] of [
      ["/files", files],
      ["/other", other],
    ] as const)
      app.get(route, (c) => {
        const found = caller(c, "files:read", [OWN]);
        return found instanceof Response ? found : c.json({ ok: true });
      });
    expect((await app.request("/files")).status).toBe(200);
    expect((await app.request("/other")).status).toBe(403);
  });

  it("leaves a non-member untouched", () => {
    expect(gate.allows("owner", [OWN])).toBe(true);
    expect(gate.allows("owner", ["/etc"], "files")).toBe(true);
  });
});

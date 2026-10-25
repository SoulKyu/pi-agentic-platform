import { PapError, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { filesRpc } from "./rpc.ts";
import type { FilesService } from "./service.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";

const caller = testCaller({ userId: "u9" });
const ctx: HandlerContext = {
  caller,
  connectionId: "c1",
  openSubscription: vi.fn(),
  closeSubscription: vi.fn(),
};

function serviceThatAnswers(): { service: FilesService; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const service: FilesService = {
    list: async (...args) => {
      calls.push(["list", ...args]);
      return { entries: [], truncated: false };
    },
    read: async (...args) => {
      calls.push(["read", ...args]);
      throw new PapError("not_found");
    },
    search: async (...args) => {
      calls.push(["search", ...args]);
      return { paths: ["a.ts"], truncated: false };
    },
    write: async (...args) => {
      calls.push(["write", ...args]);
      throw new PapError("conflict");
    },
    openRaw: async () => {
      throw new PapError("not_found");
    },
    openBoxRaw: async () => null,
  };
  return { service, calls };
}

describe("files rpc", () => {
  it("hands the transport's caller and the decoded params to the service, one call each", async () => {
    const { service, calls } = serviceThatAnswers();
    const rpc = filesRpc(service);
    await rpc["files.list"]({ path: "/p", showIgnored: true }, ctx);
    await rpc["files.search"]({ root: "/p", query: "a" }, ctx);
    await expect(rpc["files.read"]({ path: "/p/f", offset: 3 }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      rpc["files.write"]({ path: "/p/f", text: "t", baseEtag: null, confirmProtected: true }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toEqual([
      ["list", caller, { path: "/p", showIgnored: true }],
      ["search", caller, { root: "/p", query: "a" }],
      ["read", caller, { path: "/p/f", offset: 3 }],
      ["write", caller, { path: "/p/f", text: "t", baseEtag: null, confirmProtected: true }],
    ]);
  });

  it("answers not_found for a refusal and bad_request for a relative path, through the dispatcher", async () => {
    const { service } = serviceThatAnswers();
    const dispatch = createDispatcher({
      gate: NO_CLIENT_PATHS,
      handlers: filesRpc(service) as unknown as HandlerTable,
      receipts: undefined as never,
      logger: silentLogger,
    });
    expect(await dispatch({ id: 1, method: "files.read", params: { path: "/p/f" } }, ctx)).toEqual({
      id: 1,
      ok: false,
      error: { code: "not_found" },
    });
    expect(await dispatch({ id: 2, method: "files.list", params: { path: "p/f" } }, ctx)).toEqual({
      id: 2,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await dispatch({ id: 3, method: "files.read", params: { path: "/a\u0000" } }, ctx)).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
  });
});

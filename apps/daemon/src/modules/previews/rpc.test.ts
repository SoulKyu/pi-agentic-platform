import {
  type Caller,
  type HandlerContext,
  PapError,
  PREVIEWS_BROWSER_ONLY,
  previewsMethods,
} from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { previewsRpc } from "./rpc.ts";
import type { PreviewsService } from "./service.ts";

const box = { kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000001" } as const;
const view = {
  id: "a".repeat(32),
  name: "site",
  port: 3000,
  state: "running" as const,
  reason: null,
  startedAt: 1,
  network: false,
  box,
};
const lease = "ab".repeat(16);

function build() {
  const service = {
    list: vi.fn(async () => ({ services: [view] })),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ service: view })),
    startProject: vi.fn(async () => ({ service: view })),
    logs: vi.fn(async () => ({ lines: ["x"] })),
    open: vi.fn(async () => ({ url: "http://p/p/t/", lease, leaseMs: 300_000 })),
    renew: vi.fn(async () => ({ until: 5 })),
    close: vi.fn(async () => undefined),
    artifact: vi.fn(async () => ({ url: "http://p/a/t/", until: 9 })),
  } satisfies PreviewsService;
  const opened: unknown[][] = [];
  const ctxOf = (kind: Caller["kind"]): HandlerContext => ({
    caller: {
      userId: "u1",
      permissions: new Set(["sessions:operate", "sessions:read"]),
      kind,
      credentialId: "c",
      stepUpUntil: 0,
    },
    connectionId: "conn",
    openSubscription: (...args) => (opened.push(args), "sub-1"),
    closeSubscription: () => undefined,
  });
  return { service, rpc: previewsRpc(service), ctxOf, opened };
}

describe("the previews handlers", () => {
  it("one handler per method, none else", () => {
    expect(Object.keys(build().rpc).sort()).toEqual(Object.keys(previewsMethods).sort());
  });

  it("decode, call one service method and map its result to the contract's shape", async () => {
    const { rpc, service, ctxOf } = build();
    const ctx = ctxOf("session");
    expect(await rpc["previews.list"]({ box }, ctx)).toEqual({ services: [view] });
    expect(await rpc["previews.stop"]({ box, name: "site" }, ctx)).toEqual({});
    expect(await rpc["previews.restart"]({ box, name: "site" }, ctx)).toEqual({ service: view });
    expect(await rpc["previews.startProject"]({ projectId: box.id, command: "c", port: 3000 }, ctx)).toEqual({
      service: view,
    });
    expect(await rpc["previews.logs"]({ box, name: "site" }, ctx)).toEqual({ lines: ["x"] });
    expect(await rpc["previews.open"]({ box, name: "site" }, ctx)).toMatchObject({ lease });
    expect(await rpc["previews.renew"]({ lease }, ctx)).toEqual({ until: 5 });
    expect(await rpc["previews.close"]({ lease }, ctx)).toEqual({});
    expect(await rpc["previews.artifact"]({ sessionId: "s", entryId: "e", fenceIndex: 0 }, ctx)).toEqual({
      url: "http://p/a/t/",
      until: 9,
    });
    expect(service.open).toHaveBeenCalledWith(ctx.caller, box, "site");
    expect(service.startProject).toHaveBeenCalledWith(ctx.caller, {
      projectId: box.id,
      command: "c",
      port: 3000,
    });
  });

  it("a token caller is forbidden on exactly the browser-only methods, before the service is called", async () => {
    const { rpc, service, ctxOf } = build();
    const ctx = ctxOf("token");
    const params: Record<string, object> = {
      "previews.open": { box, name: "site" },
      "previews.renew": { lease },
      "previews.close": { lease },
      "previews.artifact": { sessionId: "s", entryId: "e", fenceIndex: 0 },
    };
    expect([...PREVIEWS_BROWSER_ONLY].sort()).toEqual(Object.keys(params).sort());
    for (const [name, p] of Object.entries(params)) {
      const handler = rpc[name as keyof typeof rpc] as (p: object, c: HandlerContext) => Promise<unknown>;
      await expect(handler(p, ctx), name).rejects.toEqual(new PapError("forbidden"));
    }
    for (const fn of [service.open, service.renew, service.close, service.artifact])
      expect(fn).not.toHaveBeenCalled();
    // The others are for tokens too.
    await expect(rpc["previews.list"]({ box }, ctx)).resolves.toEqual({ services: [view] });
    await expect(rpc["previews.stop"]({ box, name: "site" }, ctx)).resolves.toEqual({});
  });

  it("subscribe.previews opens the previews stream keyed by the caller's id", async () => {
    const { rpc, ctxOf, opened } = build();
    expect(await rpc["subscribe.previews"]({}, ctxOf("session"))).toEqual({ sub: "sub-1" });
    expect(opened).toEqual([["previews", "u1", undefined]]);
  });
});

import type { PlatformOp, StreamName } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { composePreviews, type PreviewsLate, type PreviewsConfig } from "./compose-previews.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import type { PlatformHandler } from "./modules/platform/index.ts";
import { PROJECT_BOX, registryBed } from "./modules/previews/testing/registry-bed.ts";

type Closers = Parameters<typeof composePreviews>[1];
const closers: Closers = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
});

const config: PreviewsConfig = {
  host: "127.0.0.1",
  tls: null,
  previewPort: 0,
  previewOrigin: null,
  publicOrigin: "http://localhost:7777",
  allowedOrigins: new Set(["http://localhost:7777"]),
};

const noText = async (): Promise<string | null> => null;

/** The service side over the registry bed's fake runtime and BoxOps. */
function serviceBed(modeOf: () => "full-access" = () => "full-access") {
  const bed = registryBed();
  const registered = new Map<string, unknown>();
  const snapshots = new Map<StreamName, (key: string) => unknown>();
  const published: Array<[StreamName, string, unknown]> = [];
  const service = {
    runtime: { ...bed.runtime, touch: () => undefined },
    hostsOf: () => [],
    ops: bed.ops,
    tunnels: { open: () => Promise.reject(new Error("unused")) },
    platform: { register: (op: PlatformOp, handler: unknown) => void registered.set(op, handler) },
    sessions: {
      projectBoxOf: () => ({ projectId: PROJECT_BOX.id }),
      shellNetwork: () => false,
      modeOf,
    },
    owners: { project: () => "u1", agent: () => "u1" },
    redact: async (line: string) => line,
  } as unknown as NonNullable<PreviewsLate["service"]>;
  const hub = {
    publish: (stream: StreamName, key: string, event: unknown) => void published.push([stream, key, event]),
    registerSnapshot: (stream: StreamName, provider: (key: string) => unknown) =>
      void snapshots.set(stream, provider),
  };
  return { bed, service, registered, snapshots, published, hub };
}

async function compose(hub?: ReturnType<typeof serviceBed>["hub"]) {
  const { logger } = captureLogger();
  return composePreviews({ config, clock: createFakeClock(), logger, ...(hub ? { hub } : {}) }, closers);
}

describe("composePreviews.bind: the service side", () => {
  it("registers preview.start and preview.stop on the platform and returns the registry, the stream and the box owner", async () => {
    const s = serviceBed();
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText, service: s.service });
    expect([...s.registered.keys()].sort()).toEqual(["preview.start", "preview.stop"]);
    expect(typeof s.registered.get("preview.start")).toBe("function");
    expect(bound.registry).not.toBeNull();
    expect(bound.ownerOf({ kind: "project", id: PROJECT_BOX.id })).toBe("u1");
    expect(s.snapshots.has("previews")).toBe(true);
  });

  it("the registered preview.start runs in the box the daemon derives, in the registry bind returned", async () => {
    const s = serviceBed();
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText, service: s.service });
    s.bed.run(PROJECT_BOX);
    const start = s.registered.get("preview.start") as PlatformHandler<"preview.start">;
    const answer = await start(
      { name: "site", command: "serve .", port: 3000 },
      {
        ownerId: "u1",
        sessionId: "s1",
        type: "plain",
        tainted: false,
        agentId: null,
        signal: new AbortController().signal,
      },
    );
    expect(answer).toMatchObject({ name: "site", status: "running" });
    expect(bound.registry?.list(PROJECT_BOX).map((view) => view.name)).toEqual(["site"]);
    expect(s.published.map(([stream, key]) => [stream, key])).toEqual([["previews", "u1"]]);
  });

  it("an agent thread's service gets the network its shell started with, through the composition (UX2-R68)", async () => {
    for (const network of [false, true]) {
      const s = serviceBed();
      s.service.sessions.shellNetwork = () => network;
      const previews = await compose(s.hub);
      const bound = previews.bind({ entryText: noText, service: s.service });
      const box = { kind: "agent", id: "atlas-0001" } as const;
      s.bed.run(box);
      const start = s.registered.get("preview.start") as PlatformHandler<"preview.start">;
      await start(
        { name: "site", command: "serve .", port: 3000 },
        {
          ownerId: "u1",
          sessionId: "s1",
          type: "agent-thread",
          tainted: false,
          agentId: "atlas-0001",
          signal: new AbortController().signal,
        },
      );
      expect(bound.registry?.list(box).map((view) => view.network)).toEqual([network]);
      for (const closer of closers.splice(0).reverse()) await closer.close();
    }
  });

  it("an agent thread with no start-time profile is forbidden through the composition, nothing started", async () => {
    const s = serviceBed();
    s.service.sessions.shellNetwork = () => null;
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText, service: s.service });
    const box = { kind: "agent", id: "atlas-0001" } as const;
    s.bed.run(box);
    const start = s.registered.get("preview.start") as PlatformHandler<"preview.start">;
    await expect(
      start(
        { name: "site", command: "serve .", port: 3000 },
        {
          ownerId: "u1",
          sessionId: "s1",
          type: "agent-thread",
          tainted: false,
          agentId: "atlas-0001",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bound.registry?.list(box)).toEqual([]);
  });

  it("a session whose mode the daemon cannot read is forbidden, never started", async () => {
    const s = serviceBed(() => {
      throw new Error("not_found");
    });
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText, service: s.service });
    s.bed.run(PROJECT_BOX);
    const start = s.registered.get("preview.start") as PlatformHandler<"preview.start">;
    await expect(
      start(
        { name: "site", command: "serve .", port: 3000 },
        {
          ownerId: "u1",
          sessionId: "s1",
          type: "plain",
          tainted: false,
          agentId: null,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bound.registry?.list(PROJECT_BOX)).toEqual([]);
  });

  it("a second bind throws and changes nothing", async () => {
    const s = serviceBed();
    const previews = await compose(s.hub);
    previews.bind({ entryText: noText, service: s.service });
    expect(() => previews.bind({ entryText: noText, service: s.service })).toThrow(
      "previews are already bound",
    );
    expect(s.registered.size).toBe(2);
  });

  it("without a service side (no VM stack) the registry is null and the snapshot is empty", async () => {
    const s = serviceBed();
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText });
    expect(bound.registry).toBeNull();
    expect(s.registered.size).toBe(0);
    expect(s.snapshots.get("previews")?.("u1")).toEqual({ type: "snapshot", services: [] });
  });

  it("a closer ends the registry's listening", async () => {
    const s = serviceBed();
    const previews = await compose(s.hub);
    const bound = previews.bind({ entryText: noText, service: s.service });
    s.bed.run(PROJECT_BOX);
    await bound.registry?.start(PROJECT_BOX, "u1", s.bed.spec("site"));
    expect(s.published).toHaveLength(1);
    for (const closer of closers.splice(0).reverse()) await closer.close();
    s.bed.halt(PROJECT_BOX);
    expect(s.published).toHaveLength(1);
  });
});

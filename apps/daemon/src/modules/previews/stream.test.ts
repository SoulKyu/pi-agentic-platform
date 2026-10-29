import type { StreamName } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createPreviewsStream } from "./stream.ts";
import { AGENT_BOX, PROJECT_BOX, registryBed } from "./testing/registry-bed.ts";

function hubBed() {
  const published: Array<{ stream: StreamName; key: string; event: unknown }> = [];
  const snapshots = new Map<StreamName, (key: string) => unknown>();
  return {
    published,
    snapshot: (key: string) => snapshots.get("previews")?.(key),
    hub: {
      publish: (stream: StreamName, key: string, event: unknown) =>
        void published.push({ stream, key, event }),
      registerSnapshot: (stream: StreamName, provider: (key: string) => unknown) =>
        void snapshots.set(stream, provider),
    },
  };
}

describe("the previews stream", () => {
  it("a member's snapshot holds only their boxes", async () => {
    const bed = registryBed();
    const hub = hubBed();
    createPreviewsStream({ hub: hub.hub, registry: bed.registry, clock: bed.clock });
    bed.run(PROJECT_BOX);
    bed.run(AGENT_BOX);
    await bed.registry.start(PROJECT_BOX, "owner", bed.spec("mine"));
    await bed.registry.start(AGENT_BOX, "member", bed.spec("theirs"));
    expect(hub.snapshot("member")).toMatchObject({
      type: "snapshot",
      services: [{ name: "theirs", box: AGENT_BOX }],
    });
    expect((hub.snapshot("owner") as { services: unknown[] }).services).toHaveLength(1);
    expect(hub.snapshot("nobody")).toEqual({ type: "snapshot", services: [] });
  });

  it("events reach the box owner only", async () => {
    const bed = registryBed();
    const hub = hubBed();
    createPreviewsStream({ hub: hub.hub, registry: bed.registry, clock: bed.clock });
    bed.run(PROJECT_BOX);
    const view = await bed.registry.start(PROJECT_BOX, "owner", bed.spec("mine"));
    bed.halt(PROJECT_BOX);
    expect(hub.published.map(({ stream, key }) => [stream, key])).toEqual([
      ["previews", "owner"],
      ["previews", "owner"],
    ]);
    expect(hub.published.map(({ event }) => event)).toEqual([
      { type: "service", service: { ...view, box: PROJECT_BOX } },
      { type: "removed", box: PROJECT_BOX, name: "mine" },
    ]);
  });

  it("an event that repeats a service unchanged inside one second is not sent again; a change or a second later is", async () => {
    const bed = registryBed();
    const hub = hubBed();
    let emit: (event: unknown, owner: string) => void = () => undefined;
    createPreviewsStream({
      hub: hub.hub,
      registry: {
        all: () => [],
        onChange: (listener: typeof emit) => ((emit = listener), () => undefined),
      } as never,
      clock: bed.clock,
    });
    const view = {
      id: "a".repeat(32),
      name: "site",
      port: 3000,
      state: "running",
      reason: null,
      startedAt: 1,
      network: false,
    };
    const event = (state: string) => ({ type: "service", service: { ...view, state, box: PROJECT_BOX } });
    emit(event("running"), "owner");
    emit(event("running"), "owner");
    expect(hub.published).toHaveLength(1);
    emit(event("exited"), "owner");
    expect(hub.published).toHaveLength(2);
    emit(event("exited"), "owner");
    expect(hub.published).toHaveLength(2);
    await bed.clock.advance(1_000);
    emit(event("exited"), "owner");
    expect(hub.published).toHaveLength(3);
  });

  it("the snapshot holds at most 256 services", () => {
    const hub = hubBed();
    const many = Array.from({ length: 300 }, (_, index) => ({ name: `s${index}` }));
    createPreviewsStream({
      hub: hub.hub,
      registry: { all: () => many, onChange: () => () => undefined } as never,
      clock: { now: () => 0 },
    });
    expect((hub.snapshot("owner") as { services: unknown[] }).services).toHaveLength(256);
  });

  it("without a registry (no VM stack) the snapshot is empty and nothing is published", () => {
    const hub = hubBed();
    createPreviewsStream({ hub: hub.hub, registry: null, clock: { now: () => 0 } });
    expect(hub.snapshot("owner")).toEqual({ type: "snapshot", services: [] });
    expect(hub.published).toEqual([]);
  });

  it("stop ends the publishing", async () => {
    const bed = registryBed();
    const hub = hubBed();
    const stream = createPreviewsStream({ hub: hub.hub, registry: bed.registry, clock: bed.clock });
    bed.run(PROJECT_BOX);
    stream.stop();
    await bed.registry.start(PROJECT_BOX, "owner", bed.spec("mine"));
    expect(hub.published).toEqual([]);
  });
});

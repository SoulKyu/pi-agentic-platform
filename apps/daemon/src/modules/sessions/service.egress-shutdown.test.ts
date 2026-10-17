import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

describe("the daemon stops (X2b)", () => {
  it("asks the egress proxy to remove its folders once the workers are stopped", async () => {
    bed = build();
    const shutdown = vi.fn(async () => {});
    bed.service.agent.setAgentPorts({ agents: { egress: { shutdown } } as never });
    await bed.service.shutdownAll();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("stops without an egress proxy bound", async () => {
    bed = build();
    await expect(bed.service.shutdownAll()).resolves.toBeUndefined();
  });
});

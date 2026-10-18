import type { ExtensionProviders } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createExtensionProviders } from "./extensions.ts";
import { modelsBed } from "./testing/bed.ts";

const answer = (name: string): ExtensionProviders => ({
  providers: [{ id: "x", name, models: [], modelsTruncated: false }],
  truncated: false,
  failed: false,
});

/** A helper whose runs the test answers one by one. */
function bed() {
  const runs: Array<(value: ExtensionProviders) => void> = [];
  const providers = createExtensionProviders({
    ask: () => new Promise<ExtensionProviders>((resolve) => void runs.push(resolve)),
  });
  return { providers, runs };
}

describe("the daemon's shared extension run (review M2)", () => {
  it("joins a run in flight", async () => {
    const { providers, runs } = bed();
    const first = providers.get();
    const second = providers.get();
    expect(runs).toHaveLength(1);
    runs[0]?.(answer("one"));
    expect(await first).toBe(await second);
  });

  it("share.after-write: a read asked after a write never joins a run that started before it", async () => {
    const { providers, runs } = bed();
    const before = providers.get();
    providers.invalidate();
    const after = providers.get();
    expect(runs).toHaveLength(2);
    runs[0]?.(answer("before the write"));
    runs[1]?.(answer("after the write"));
    expect((await before).providers[0]?.name).toBe("before the write");
    expect((await after).providers[0]?.name).toBe("after the write");
    // The newer run is the one later reads join.
    const later = providers.get();
    expect(runs).toHaveLength(3);
    runs[2]?.(answer("later"));
    expect((await later).providers[0]?.name).toBe("later");
  });

  it("share.service: every write of Pi's files the service makes ends the sharing of an older run", async () => {
    const runs: Array<(value: ExtensionProviders) => void> = [];
    const { service, calls } = modelsBed((call) =>
      call.op === "models.extensions"
        ? new Promise<ExtensionProviders>((resolve) => void runs.push(resolve))
        : { patterns: null },
    );
    const before = service.extensions();
    await service.setEnabled(testCaller(), { op: { op: "clear" } });
    const after = service.extensions();
    expect(calls.filter((call) => call.op === "models.extensions")).toHaveLength(2);
    runs[0]?.(answer("before"));
    runs[1]?.(answer("after"));
    expect((await before).providers[0]?.name).toBe("before");
    expect((await after).providers[0]?.name).toBe("after");
  });
});

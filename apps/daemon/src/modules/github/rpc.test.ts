import { afterEach, describe, expect, it } from "vitest";
import { type FeatureBed, PAP_ORIGIN, startFeatureBed } from "./testing/feature.ts";

let bed: FeatureBed;
afterEach(() => bed.close());

describe("account RPCs", () => {
  it("pass the connection's Origin to the service and answer contract-shaped results", async () => {
    bed = await startFeatureBed();
    const ctx = { caller: bed.caller, connectionId: "c1", origin: PAP_ORIGIN } as never;
    const { rpc } = bed.feature;
    expect((await rpc["github.status"]({}, ctx)).status.state).toBe("absent");
    const started = await rpc["github.startCreate"]({}, ctx);
    expect(started.postUrl).toBe(`${PAP_ORIGIN}/github/app/new?state=${started.state}`);
    bed.core.appSecrets.save(bed.app);
    expect(
      (await rpc["github.status"]({}, { ...(ctx as object), origin: "http://elsewhere.test" } as never))
        .status.app?.originMatches,
    ).toBe(false);
    expect(new URL((await rpc["github.authorizeUrl"]({}, ctx)).url).pathname).toBe("/login/oauth/authorize");
    expect(await rpc["github.disconnect"]({}, ctx)).toEqual({ ok: true });
  });
});

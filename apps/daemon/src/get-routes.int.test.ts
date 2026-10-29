import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET_EFFECT, GET_MIDDLEWARE } from "./testing/get-routes.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

// Decision 139 (red team I1): every GET route of the real daemon is classified, and a classified route exists.
let t: TestDaemon;
beforeAll(async () => {
  t = await startTestDaemon({ steps: [] }, { config: { metricsToken: "m".repeat(32) } });
}, 60_000);
afterAll(async () => t?.stop());

describe("GET routes against a page that holds pap's cookie", () => {
  it("every GET route is side-effect-free, nonce-bound, origin-checked or public, and every listed route is served", () => {
    const served = [...new Set(t.daemon.inspect.routes())].filter(
      (route) => (route.startsWith("GET ") || route.startsWith("ALL ")) && !GET_MIDDLEWARE.has(route),
    );
    expect(served.filter((route) => !(route in GET_EFFECT))).toEqual([]);
    expect(Object.keys(GET_EFFECT).filter((route) => !served.includes(route))).toEqual([]);
  });
});

import type { ModelsOverview } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createProviderKinds } from "./auth-kinds.ts";

const provider = (id: string) => ({
  id,
  name: id,
  auth: { oauthLabel: null, apiKey: true, configured: true, stored: "api_key", status: "known", env: [] },
});
const overview = (ids: string[]) => ({ providers: ids.map(provider) }) as unknown as ModelsOverview;

describe("provider kinds", () => {
  it("a failed default row never rejects the overview: it is logged and the kinds still answer", async () => {
    const warn = vi.fn();
    const kinds = createProviderKinds({
      overview: () => Promise.resolve(overview(["acme", "beta"])),
      clock: createFakeClock(),
      logger: { warn },
      onSeen: (id) => {
        if (id === "acme") throw new Error("SQLITE_BUSY");
      },
    });
    const map = await kinds.get();
    expect([...map.keys()]).toEqual(["acme", "beta"]);
    expect(warn).toHaveBeenCalledWith(
      "provider_sharing_seed_failed",
      expect.objectContaining({ provider: "acme" }),
    );
  });
});

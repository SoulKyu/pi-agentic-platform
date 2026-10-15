import * as contracts from "@pap/contracts";
import { describe, expect, it } from "vitest";
import * as kernel from "./child-env.ts";
import type { EnvSource, UnattendedExtra } from "./child-env.ts";

describe("kernel/child-env re-export", () => {
  it("is the contract's own unattended environment", () => {
    expect(kernel.unattendedEnv).toBe(contracts.unattendedEnv);
    expect(kernel.NETWORK_ENV).toBe(contracts.NETWORK_ENV);
    expect(kernel.TOOLING_ENV).toBe(contracts.TOOLING_ENV);
    expect(kernel.isNeverPassedEnvKey).toBe(contracts.isNeverPassedEnvKey);
    expect(kernel.FALLBACK_PATH).toBe(contracts.FALLBACK_PATH);
  });
  it("types an environment as a plain record, so a caller can pass process.env", () => {
    const base: EnvSource = { HOME: "/h" };
    const extra: UnattendedExtra = { keep: ["TMPDIR"], set: { PAP_LANE_ID: "l" } };
    expect(kernel.unattendedEnv(base, extra).PAP_LANE_ID).toBe("l");
  });
});

import { methods } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import "./register-compare-catalog.ts";
import { compareFailureKey } from "./use-compare.ts";

describe("compareFailureKey", () => {
  it.each(["lanes.compare", "lanes.closeLosers"] as const)(
    "has its own words for every code %s declares (a declared code never reads as a plain failure)",
    (name) => {
      for (const code of methods[name].errors) {
        const key = compareFailureKey(new RpcError(code));
        expect([name, code, key]).toEqual([name, code, `compare.error.${code}`]);
        expect(translate("en", key)).not.toBe(translate("en", "compare.error.other"));
        expect(translate("fr", key)).not.toBe(translate("fr", "compare.error.other"));
      }
    },
  );

  it("says the disk is almost full for disk_low", () => {
    expect(translate("en", compareFailureKey(new RpcError("disk_low")))).toMatch(/disk is almost full/);
  });

  it("falls back to the plain failure for a code the calls do not declare", () => {
    expect(compareFailureKey(new RpcError("forbidden"))).toBe("compare.error.other");
    expect(compareFailureKey(new Error("x"))).toBe("compare.error.other");
  });
});

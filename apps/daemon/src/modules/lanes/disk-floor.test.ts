import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { guardSnapshot } from "./disk-floor.ts";

const throwing = (error: unknown) => (): undefined => {
  throw error;
};

describe("guardSnapshot", () => {
  it("refuses a read-only daemon with read_only, before it asks the floor", () => {
    let asked = false;
    const diskFloor = (): undefined => {
      asked = true;
      return undefined;
    };
    expect(() => guardSnapshot({ readOnly: true, diskFloor }, "/w")).toThrow(
      expect.objectContaining({ code: "read_only" }),
    );
    expect(asked).toBe(false);
  });

  it("lets the floor's own disk_low through (M10's guard, R1)", () => {
    const diskFloor = throwing(new PapError("disk_low"));
    expect(() => guardSnapshot({ readOnly: false, diskFloor }, "/w")).toThrow(
      expect.objectContaining({ code: "disk_low" }),
    );
  });

  it("answers capacity to a floor that fails any other way", () => {
    const diskFloor = throwing(new Error("statfs exploded"));
    expect(() => guardSnapshot({ readOnly: false, diskFloor }, "/w")).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
  });

  it("passes when the floor holds", () => {
    expect(() => guardSnapshot({ readOnly: false, diskFloor: () => undefined }, "/w")).not.toThrow();
  });
});

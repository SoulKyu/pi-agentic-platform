import { describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { failureCode, failureText, outcomeUnknown } from "./failure.ts";

describe("failure", () => {
  it("reads the code of an rpc error and calls anything else internal", () => {
    expect(failureCode(new RpcError("capacity"))).toBe("capacity");
    expect(failureCode(new RpcError("offline"))).toBe("offline");
    expect(failureCode(new TypeError("boom"))).toBe("internal");
    expect(failureCode(undefined)).toBe("internal");
  });

  it("words it for the user, with a generic sentence for a code it has no text for", () => {
    expect(failureText(new RpcError("invalid_cwd"))).toBe(
      "The working directory must be an absolute path to an existing folder.",
    );
    expect(failureText(new RpcError("teapot" as never))).toBe("Something went wrong.");
    expect(failureText(new Error("x"))).toBe("Something went wrong.");
  });

  it("knows which failures leave the outcome of a mutation open", () => {
    expect(outcomeUnknown(new RpcError("timeout"))).toBe(true);
    expect(outcomeUnknown(new RpcError("connection_lost"))).toBe(true);
    for (const code of ["offline", "capacity", "prompt_rejected", "internal"] as const) {
      expect(outcomeUnknown(new RpcError(code)), code).toBe(false);
    }
    expect(outcomeUnknown(new Error("x"))).toBe(false);
  });
});

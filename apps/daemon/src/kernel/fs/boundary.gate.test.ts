import { describe, expect, it } from "vitest";
import { gateWrite, type CallerKind, type Protection } from "./boundary.ts";

const NOW = 1_000_000;
const gate = (kind: CallerKind, protection: Protection, confirmProtected: boolean, stepUpUntil = 0): string =>
  gateWrite({ protection, caller: { kind, stepUpUntil }, confirmProtected, now: NOW });

describe("gateWrite for a token", () => {
  it("writes an ordinary path", () => {
    expect(gate("token", "none", false)).toBe("ok");
  });

  it("never confirms: the flag alone is forbidden", () => {
    expect(gate("token", "none", true)).toBe("forbidden");
  });

  it("never writes a protected path, with or without the flag, with or without a step-up", () => {
    for (const protection of ["confirm", "step_up"] as const)
      for (const flag of [false, true])
        expect(gate("token", protection, flag, NOW + 60_000), `${protection} ${flag}`).toBe("forbidden");
  });
});

describe("gateWrite for a browser session", () => {
  it("writes an ordinary path without asking", () => {
    expect(gate("session", "none", false)).toBe("ok");
  });

  it("asks for the confirmation on a protected path, and accepts it", () => {
    expect(gate("session", "confirm", false)).toBe("protected_path");
    expect(gate("session", "confirm", true)).toBe("ok");
  });

  it("asks for the confirmation on a step_up path even with a live step-up: the password never replaces it", () => {
    expect(gate("session", "step_up", false, NOW + 1)).toBe("protected_path");
  });

  it("then asks for a step-up unless it is still live", () => {
    expect(gate("session", "step_up", true, NOW)).toBe("step_up_required");
    expect(gate("session", "step_up", true, 0)).toBe("step_up_required");
    expect(gate("session", "step_up", true, NOW + 1)).toBe("ok");
  });
});

import { describe, expect, it } from "vitest";
import { classifyExit, describeExit } from "./exit.ts";

describe("exit causes", () => {
  it("classifies exits", () => {
    expect(classifyExit(0, null).cause).toBe("clean");
    expect(classifyExit(70, null).cause).toBe("exit_code");
    expect(classifyExit(null, "SIGTERM").cause).toBe("signal");
    expect(classifyExit(null, "SIGKILL").cause).toBe("killed");
  });

  it("describes them for a banner", () => {
    expect(describeExit(classifyExit(null, "SIGKILL"))).toBe(
      "Agent process killed (SIGKILL), possibly out of memory.",
    );
    expect(describeExit(classifyExit(70, null))).toBe("Agent process exited with code 70.");
    expect(describeExit({ code: null, signal: null, cause: "spawn_failure" })).toBe(
      "Agent process could not start.",
    );
  });
});

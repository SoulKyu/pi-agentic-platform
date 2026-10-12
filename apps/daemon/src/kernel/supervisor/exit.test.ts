import { describe, expect, it } from "vitest";
import { classifyExit, describeExit } from "./exit.ts";

describe("exit causes", () => {
  it("classifies exits", () => {
    expect(classifyExit(0, null).cause).toBe("clean");
    expect(classifyExit(70, null).cause).toBe("exit_code");
    expect(classifyExit(null, "SIGTERM").cause).toBe("signal");
    expect(classifyExit(null, "SIGKILL").cause).toBe("killed");
  });

  it("describes them for a banner, with the stable code the web translates (R128)", () => {
    expect(describeExit(classifyExit(null, "SIGKILL"))).toEqual({
      text: "Agent process killed (SIGKILL), possibly out of memory.",
      code: "process_killed",
    });
    expect(describeExit(classifyExit(70, null))).toEqual({
      text: "Agent process exited with code 70.",
      code: "process_exit_code",
      params: { code: "70" },
    });
    expect(describeExit({ code: null, signal: "SIGKILL", cause: "oom" })).toEqual({
      text: "Agent process ran out of memory and was stopped.",
      code: "process_oom",
    });
    expect(describeExit({ code: null, signal: null, cause: "spawn_failure" })).toEqual({
      text: "Agent process could not start.",
      code: "process_spawn_failure",
    });
    expect(describeExit(classifyExit(0, null))).toEqual({
      text: "Agent process stopped.",
      code: "process_stopped",
    });
    expect(describeExit(classifyExit(null, "SIGTERM"))).toEqual({
      text: "Agent process stopped by SIGTERM.",
      code: "process_signal",
      params: { signal: "SIGTERM" },
    });
    expect(describeExit({ code: null, signal: null, cause: "signal" })).toEqual({
      text: "Agent process stopped by a signal.",
      code: "process_signal_unknown",
    });
    expect(describeExit({ code: null, signal: null, cause: "exit_code" })).toEqual({
      text: "Agent process exited with code unknown.",
      code: "process_exit_code",
      params: { code: "unknown" },
    });
  });
});

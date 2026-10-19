import { describe, expect, it } from "vitest";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { checkAgentResources } from "./resources-check.ts";

const HOST = { memoryCapMb: 8192, cores: 4 };
const base = { memoryMb: 1024, cpus: 2, diskMb: 4096 };
const outcome = (input: object, was: typeof base | null = null) => {
  const logs = captureLogger();
  let code: string | null = null;
  try {
    checkAgentResources({ ...base, ...input }, was, HOST, logs.logger);
  } catch (error) {
    code = (error as { code: string }).code;
  }
  return { code, fields: logs.lines.map((line) => line["field"]) };
};

describe("checkAgentResources (RT-30)", () => {
  it("accepts a plain save and a smaller memory or CPU count", () => {
    expect(() => checkAgentResources(base, null, HOST, captureLogger().logger)).not.toThrow();
    expect(() =>
      checkAgentResources({ ...base, memoryMb: 512, cpus: 1 }, base, HOST, captureLogger().logger),
    ).not.toThrow();
  });
  it("accepts a memory exactly at the cap with the overhead, and as many CPUs as cores", () => {
    expect(() =>
      checkAgentResources(
        { ...base, memoryMb: 8192 - VM_OVERHEAD_MB, cpus: 4 },
        null,
        HOST,
        captureLogger().logger,
      ),
    ).not.toThrow();
  });
  it("refuses a memory that with the overhead passes the cap", () => {
    expect(outcome({ memoryMb: 8192 - VM_OVERHEAD_MB + 1 })).toEqual({
      code: "bad_request",
      fields: ["memoryMb"],
    });
  });
  it("refuses more CPUs than the host has cores", () => {
    expect(outcome({ cpus: 5 })).toEqual({ code: "bad_request", fields: ["cpus"] });
  });
  it("refuses a disk smaller than the saved one, accepts the same or a larger one", () => {
    expect(outcome({ diskMb: 4095 }, base)).toEqual({ code: "bad_request", fields: ["diskMb"] });
    expect(() =>
      checkAgentResources({ ...base, diskMb: 4096 }, base, HOST, captureLogger().logger),
    ).not.toThrow();
    expect(() =>
      checkAgentResources({ ...base, diskMb: 8192 }, base, HOST, captureLogger().logger),
    ).not.toThrow();
    expect(() =>
      checkAgentResources({ ...base, diskMb: 1024 }, null, HOST, captureLogger().logger),
    ).not.toThrow();
  });
});

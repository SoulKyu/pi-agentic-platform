import { describe, expect, it } from "vitest";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import { checkAgentResources } from "./resources-check.ts";

const HOST = { memoryCapMb: 8192, cores: 4 };
const base = { memoryMb: 1024, cpus: 2, diskMb: 4096 };
const fieldOf = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return { code: (error as { code: string }).code, field: (error as { field?: string }).field };
  }
  return null;
};

describe("checkAgentResources (RT-30)", () => {
  it("accepts a plain save and a smaller memory or CPU count", () => {
    expect(() => checkAgentResources(base, null, HOST)).not.toThrow();
    expect(() => checkAgentResources({ ...base, memoryMb: 512, cpus: 1 }, base, HOST)).not.toThrow();
  });
  it("accepts a memory exactly at the cap with the overhead, and as many CPUs as cores", () => {
    expect(() =>
      checkAgentResources({ ...base, memoryMb: 8192 - VM_OVERHEAD_MB, cpus: 4 }, null, HOST),
    ).not.toThrow();
  });
  it("refuses a memory that with the overhead passes the cap", () => {
    expect(
      fieldOf(() => checkAgentResources({ ...base, memoryMb: 8192 - VM_OVERHEAD_MB + 1 }, null, HOST)),
    ).toEqual({
      code: "bad_request",
      field: "memoryMb",
    });
  });
  it("refuses more CPUs than the host has cores", () => {
    expect(fieldOf(() => checkAgentResources({ ...base, cpus: 5 }, null, HOST))).toEqual({
      code: "bad_request",
      field: "cpus",
    });
  });
  it("refuses a disk smaller than the saved one, accepts the same or a larger one", () => {
    expect(fieldOf(() => checkAgentResources({ ...base, diskMb: 4095 }, base, HOST))).toEqual({
      code: "bad_request",
      field: "diskMb",
    });
    expect(() => checkAgentResources({ ...base, diskMb: 4096 }, base, HOST)).not.toThrow();
    expect(() => checkAgentResources({ ...base, diskMb: 8192 }, base, HOST)).not.toThrow();
    expect(() => checkAgentResources({ ...base, diskMb: 1024 }, null, HOST)).not.toThrow();
  });
});

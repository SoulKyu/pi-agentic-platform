/** R29: what one VM costs besides its agent's memory (Kata's guest kernel and hypervisor); 512 until T20a measures it. */
export const VM_OVERHEAD_MB = 512;
const MIN_MEMORY_MAX_MB = 1024;

/** The agents-in-VM settings of `loadConfig`. */
export interface AgentsVmEnv {
  /** `PAP_AGENTS_RUNTIME`: `host` (default, bwrap on the host) or `vm`. */
  readonly agentsRuntime: "host" | "vm";
  /** `PAP_AGENTS_MEMORY_MAX_MB`: the cap on the memory of every running agent VM together (each counts its `memoryMb` plus `VM_OVERHEAD_MB`). */
  readonly agentsMemoryMaxMb: number;
  /** `PAP_TEST_AGENT_RUNTIME=process`, with the scripted provider: agents run as local processes (tests only). */
  readonly testAgentRuntime: "process" | null;
}

/** Messages are fixed text: the value is never echoed. */
export function parseAgentsVm(
  env: NodeJS.ProcessEnv,
  totalMemMb: number,
  scriptSet: boolean,
  refuse: (message: string) => Error,
): AgentsVmEnv {
  const runtime = env.PAP_AGENTS_RUNTIME;
  if (runtime !== undefined && runtime !== "" && runtime !== "host" && runtime !== "vm")
    throw refuse("PAP_AGENTS_RUNTIME must be host or vm");
  const test = env.PAP_TEST_AGENT_RUNTIME;
  if (test !== undefined && test !== "process") throw refuse("PAP_TEST_AGENT_RUNTIME must be process");
  if (test !== undefined && !scriptSet) throw refuse("PAP_TEST_AGENT_RUNTIME needs PAP_TEST_PROVIDER_SCRIPT");
  const rawMemory = env.PAP_AGENTS_MEMORY_MAX_MB;
  let memory = Math.max(MIN_MEMORY_MAX_MB, Math.floor(totalMemMb / 2));
  if (rawMemory !== undefined && rawMemory !== "") {
    const value = Number(rawMemory);
    if (!Number.isInteger(value) || value < MIN_MEMORY_MAX_MB)
      throw refuse(`PAP_AGENTS_MEMORY_MAX_MB must be an integer ≥ ${MIN_MEMORY_MAX_MB}`);
    memory = value;
  }
  return {
    agentsRuntime: runtime === "vm" ? "vm" : "host",
    agentsMemoryMaxMb: memory,
    testAgentRuntime: test === undefined ? null : "process",
  };
}

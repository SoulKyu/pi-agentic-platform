/** R29: what one VM costs besides its agent's memory (Kata's guest kernel and hypervisor); 512 until T20a measures it. */
export const VM_OVERHEAD_MB = 512;
const MIN_MEMORY_MAX_MB = 1024;

/** The agents-in-VM settings of `loadConfig`. */
export interface AgentsVmEnv {
  /** `PAP_AGENTS_RUNTIME` is set, any value: it is ignored, and the boot says so. */
  readonly agentsRuntimeSet: boolean;
  /** `PAP_AGENTS_MEMORY_MAX_MB`: the cap on the memory of every running agent VM together (each counts its `memoryMb` plus `VM_OVERHEAD_MB`). */
  readonly agentsMemoryMaxMb: number;
  /** `PAP_DEV_VMD=1`: a `--dev` daemon may dial the real pap-vmd (its boot stops every VM pap-vmd lists, so it is opt-in). */
  readonly devVmd: boolean;
  /** `PAP_TEST_AGENT_RUNTIME=process`, with the scripted provider: agents run as local processes (tests only). */
  readonly testAgentRuntime: "process" | null;
  /** `PAP_TEST_VMD_SOCKET`, with the scripted provider: the pap-vmd socket a test daemon dials, never the real one (tests only). */
  readonly testVmdSocket: string | null;
  /** `PAP_TEST_GITHUB_ORIGIN`, with the scripted provider: the fake GitHub on loopback that replaces github.com and api.github.com (tests only). */
  readonly testGithubOrigin: string | null;
}

/** A bare `http://127.0.0.1:<port>` (or `localhost`) origin: the fake GitHub is never anywhere else. */
function loopbackOrigin(value: string, refuse: (message: string) => Error): string {
  const fixed = "PAP_TEST_GITHUB_ORIGIN must be a loopback http origin";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse(fixed);
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !bare || !url.port)
    throw refuse(fixed);
  return url.origin;
}

/** Messages are fixed text: the value is never echoed. */
export function parseAgentsVm(
  env: NodeJS.ProcessEnv,
  totalMemMb: number,
  scriptSet: boolean,
  refuse: (message: string) => Error,
): AgentsVmEnv {
  const test = env.PAP_TEST_AGENT_RUNTIME;
  if (test !== undefined && test !== "process") throw refuse("PAP_TEST_AGENT_RUNTIME must be process");
  if (test !== undefined && !scriptSet) throw refuse("PAP_TEST_AGENT_RUNTIME needs PAP_TEST_PROVIDER_SCRIPT");
  const socket = env.PAP_TEST_VMD_SOCKET;
  if (socket !== undefined && !scriptSet) throw refuse("PAP_TEST_VMD_SOCKET needs PAP_TEST_PROVIDER_SCRIPT");
  const github = env.PAP_TEST_GITHUB_ORIGIN;
  if (github !== undefined && !scriptSet)
    throw refuse("PAP_TEST_GITHUB_ORIGIN needs PAP_TEST_PROVIDER_SCRIPT");
  const rawMemory = env.PAP_AGENTS_MEMORY_MAX_MB;
  let memory = Math.max(MIN_MEMORY_MAX_MB, Math.floor(totalMemMb / 2));
  if (rawMemory !== undefined && rawMemory !== "") {
    const value = Number(rawMemory);
    if (!Number.isInteger(value) || value < MIN_MEMORY_MAX_MB)
      throw refuse(`PAP_AGENTS_MEMORY_MAX_MB must be an integer ≥ ${MIN_MEMORY_MAX_MB}`);
    memory = value;
  }
  return {
    agentsRuntimeSet: env.PAP_AGENTS_RUNTIME !== undefined,
    agentsMemoryMaxMb: memory,
    devVmd: env.PAP_DEV_VMD === "1",
    testAgentRuntime: test === undefined ? null : "process",
    testVmdSocket: socket === undefined || socket === "" ? null : socket,
    testGithubOrigin: github === undefined || github === "" ? null : loopbackOrigin(github, refuse),
  };
}

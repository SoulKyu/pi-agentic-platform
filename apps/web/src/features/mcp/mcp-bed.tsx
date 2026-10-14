import type { McpOverview, McpServerView } from "@pap/contracts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { McpSection } from "./McpSection.tsx";
import type { StepUpRunner } from "./step-up.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };
export const CWD = "/work/app";
export const PROJECT_FILE = "/work/app/.pi/mcp.json";

export const serverOf = (over: Partial<McpServerView> = {}): McpServerView => ({
  name: "fs",
  scope: "global",
  kind: "stdio",
  enabled: true,
  exposure: "direct",
  target: "npx -y •••",
  envNames: [],
  headerNames: [],
  commandFields: [],
  variables: [],
  oauth: false,
  toolExposureCount: 0,
  state: "on",
  lastTest: null,
  problem: null,
  ...over,
});

export const overviewOf = (over: Partial<McpOverview> = {}): McpOverview => ({
  global: {
    path: "/home/a/.pi/agent/mcp.json",
    problem: null,
    trusted: null,
    servers: [
      serverOf(),
      serverOf({
        name: "docs",
        kind: "http",
        target: "https://docs.example/mcp",
        enabled: false,
        state: "disabled",
      }),
    ],
  },
  project: {
    path: PROJECT_FILE,
    problem: null,
    trusted: true,
    servers: [serverOf({ name: "local", scope: "project" })],
  },
  codemode: { autoEnable: true, source: "default" },
  settings: { choice: "automatic", mode: "on", inlineBudget: null },
  codemodeBuiltinOff: false,
  ...over,
});

export function newBed(overview: McpOverview = overviewOf()) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["mcp.overview"] = () => overview;
  return bed;
}

/** Stands in for the host's password prompt: `answer` is what the person does when asked. */
export const prompt = { answer: true, asked: 0 };
export const stepUp: StepUpRunner = async (run) => {
  try {
    return await run("stub-command");
  } catch (failure) {
    if (!(failure instanceof RpcError) || failure.code !== "step_up_required") throw failure;
    prompt.asked += 1;
    return prompt.answer ? run("stub-command") : null;
  }
};
/** `null`: no folder chosen. */
export const show = (cwd: string | null = CWD) =>
  mount(<McpSection stepUp={stepUp} cwd={cwd ?? undefined} />);
export const rowButton = (container: ParentNode, id: string) =>
  container.querySelector(`[data-server="${id}"]`) as HTMLButtonElement;
export const switchOf = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('[data-slot="switch"]')]
    .filter((one) => one.querySelector("label")?.textContent === label)
    .map((one) => one.querySelector('[role="switch"]') as HTMLButtonElement)[0] as HTMLButtonElement;

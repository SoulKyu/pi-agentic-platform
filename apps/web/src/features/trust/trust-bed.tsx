import type { McpServerView, TrustSetResult, TrustStatus } from "@pap/contracts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { ReactNode } from "react";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };
export const CWD = "/work/app";

export const serverOf = (over: Partial<McpServerView> = {}): McpServerView => ({
  name: "fs",
  scope: "project",
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
  state: "not-trusted",
  lastTest: null,
  problem: null,
  ...over,
});

export const statusOf = (
  over: Partial<TrustStatus["resources"]> = {},
  top: Partial<Omit<TrustStatus, "resources">> = {},
): TrustStatus => ({
  requiresTrust: true,
  decision: null,
  decisionPath: null,
  inherited: false,
  resources: {
    mcpServers: [serverOf()],
    extensions: ["deploy.ts"],
    skills: ["review"],
    promptTemplates: 2,
    settingsKeys: ["packages"],
    systemPrompt: false,
    truncated: false,
    unlisted: [],
    ...over,
  },
  ...top,
});

export function newBed(status: TrustStatus = statusOf(), result: TrustSetResult = { ok: true }) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["trust.status"] = () => status;
  bed.handlers["trust.set"] = () => result;
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

/** What the shell provides to a feature: the stub runner above stands in for the password prompt. */
export const withStepUp = (children: ReactNode) => (
  <StepUpContext.Provider value={stepUp}>{children}</StepUpContext.Provider>
);

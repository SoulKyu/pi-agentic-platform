import "../../i18n/register-automation.ts";
import type {
  AgentSummary,
  ProjectSummary,
  TaskFailure,
  TasksCounts,
  TaskTrigger,
  TaskView,
} from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import type { ReactElement } from "react";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };
export const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

export const taskOf = (over: Partial<TaskView> = {}): TaskView => ({
  id: "t1",
  triggerId: "g1",
  triggerName: "Investigate HighMemory",
  projectId: "p1",
  state: "running",
  reason: null,
  origin: "webhook",
  title: "Investigate HighMemory",
  detail: "FIRING HighMemory pod=api-7f9c",
  createdAt: NOW - 120_000,
  startedAt: NOW - 120_000,
  endedAt: null,
  sessionId: "s1",
  needsInput: false,
  costUsd: 0.21,
  resetAt: null,
  toolsReleased: false,
  ...over,
});

export const triggerOf = (over: Partial<TaskTrigger> = {}): TaskTrigger => ({
  id: "g1",
  name: "prod-alerts",
  enabled: true,
  sourceType: "webhook",
  projectId: "p1",
  state: "ok",
  nextFireAt: null,
  ...over,
});

export const agentOf = (id: string, name: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
  ...patch,
});

export const countsOf = (over: Partial<TasksCounts> = {}): TasksCounts => ({
  paused: false,
  slots: 2,
  running: 1,
  queued: 3,
  quietHours: false,
  todayUsd: 1.84,
  budgetUsd: 5,
  ...over,
});

export const failureOf = (over: Partial<TaskFailure> = {}): TaskFailure => ({
  id: 7,
  kind: "run.resume",
  lastError: "worker_failed",
  settledAt: NOW - 300_000,
  ...over,
});

export const projectOf = (id: string, name: string, position = 1): ProjectSummary => ({
  id,
  root: `/work/${name}`,
  name,
  position,
  sessions: 1,
});

export const newBed = () => {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  return bed;
};

/** Stands in for the shell's password prompt: `answer` is what the person does when asked. */
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

export const showWithStepUp = (element: ReactElement) =>
  mount(
    <StepUpContext.Provider value={stepUp}>
      <TooltipProvider>{element}</TooltipProvider>
    </StepUpContext.Provider>,
  );

import type { PluginView, SkillView } from "@pap/contracts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SkillsSection } from "./SkillsSection.tsx";
import type { ProjectRef } from "./skills.vm.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };
export const PROJECT: ProjectRef = { root: "/work/app", name: "app" };
export const PROTECTED_ASK = "This changes /work/app/.pi, which can run commands later. Save anyway?";

export const skillOf = (over: Partial<SkillView> = {}): SkillView => ({
  name: "review",
  description: "Reviews a diff",
  path: "/home/a/.pi/agent/skills/review/SKILL.md",
  scope: "user",
  disableModelInvocation: false,
  ...over,
});

export const SKILLS: readonly SkillView[] = [
  skillOf(),
  skillOf({ name: "lint", path: "/home/a/.pi/agent/skills/lint/SKILL.md", disableModelInvocation: true }),
  skillOf({ name: "deploy", path: "/work/app/.pi/skills/deploy/SKILL.md", scope: "project" }),
];

export const pluginOf = (over: Partial<PluginView> = {}): PluginView => ({
  source: "npm:@acme/tools",
  scope: "user",
  installedPath: "/home/a/.pi/agent/npm/tools",
  enabled: true,
  filtered: false,
  ...over,
});

export const trustStatus = (requiresTrust: boolean, decision: boolean | null = null) => ({
  requiresTrust,
  decision,
  decisionPath: null,
  inherited: false,
  resources: {
    mcpServers: [],
    extensions: ["deploy.ts"],
    skills: [],
    promptTemplates: 0,
    settingsKeys: [],
    systemPrompt: false,
    truncated: false,
    unlisted: [],
  },
});

export function newBed(skills: readonly SkillView[] = SKILLS, plugins: readonly PluginView[] = [pluginOf()]) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["skills.list"] = () => ({ skills, truncated: false });
  bed.handlers["plugins.list"] = () => ({ plugins, truncated: false });
  bed.handlers["trust.status"] = () => trustStatus(false, true);
  return bed;
}

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

export const show = (project: ProjectRef | null = PROJECT) =>
  mount(
    <StepUpContext.Provider value={stepUp}>
      <SkillsSection project={project} />
    </StepUpContext.Provider>,
  );

export const switchOf = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('[data-slot="switch"]')]
    .filter((one) => one.querySelector("label")?.textContent === label)
    .map((one) => one.querySelector('[role="switch"]') as HTMLButtonElement)[0] as HTMLButtonElement;

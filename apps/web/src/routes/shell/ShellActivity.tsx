import { agentTarget } from "../../features/agents/rail.vm.ts";
import { ActivityButton } from "../../features/launch/ActivityButton.tsx";
import { pathOfItem } from "../../features/workspace/index.ts";

const WHERE = {
  agentPath: (agent: Parameters<typeof agentTarget>[0]) => pathOfItem(agentTarget(agent)),
  lanePath: (id: string) => pathOfItem({ kind: "lane", id }),
};

/** The "{count} in progress" button of the rail and the phone's top bar, with the shell's paths. */
export function ShellActivity() {
  return <ActivityButton where={WHERE} />;
}

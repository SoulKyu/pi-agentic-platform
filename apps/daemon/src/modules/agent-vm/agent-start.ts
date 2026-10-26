import { type AgentInput, type BoxRef, PapError } from "@pap/contracts";
import {
  imageStep,
  type ImageObserver,
  type LaunchHandle,
  type LaunchRegistry,
  launchCodeOf,
  stepAround,
} from "../../kernel/launches.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface AgentStartDeps {
  readonly runtime: Pick<AgentRuntime, "start" | "link">;
  readonly launches: Pick<LaunchRegistry, "open">;
  /** What a launch checks before a VM starts (pap-vmd usable, relay ready, bundle current, account enabled). */
  readonly gate: (box: BoxRef, launch?: Pick<LaunchHandle, "wait">) => Promise<void>;
  imageTagOf(
    agentId: string,
    input: AgentInput,
    kind: "thread",
    observe?: ImageObserver,
  ): string | Promise<string>;
  /** The owner's agent as the registry holds it; null for one that is not theirs, unknown, or whose profile is unreadable. */
  agentOf(
    ownerId: string,
    agentId: string,
  ): { readonly input: AgentInput; readonly paused: boolean; readonly quarantined: boolean } | null;
  /** After the image wait, just before the VM starts: throws when the agent was quarantined or deleted meanwhile. */
  recheck(ownerId: string, agentId: string): void;
  /** The agent's owner is a disabled account (checked again right before the VM starts, as `guardedLaunch` does). */
  disabled(box: BoxRef): boolean;
}

/**
 * Starts an agent's thread VM with its guest only: no worker, no prompt (`agents.startBox`), so its files can be browsed. A thread VM that
 * already runs is left alone and opens no launch; two calls for one agent share one start; the launch ends on every way out.
 * Not serialized with a stop (unlike `box-control`'s `inOrder`): an agent has no restart path, so a stop racing a start relies
 * on the runtime's close and its `stopped` answer.
 */
export function createAgentStart(deps: AgentStartDeps): (ownerId: string, agentId: string) => Promise<void> {
  const starting = new Map<string, Promise<void>>();

  async function bringUp(ownerId: string, agentId: string): Promise<void> {
    const agent = deps.agentOf(ownerId, agentId);
    if (agent === null) throw new PapError("not_found");
    if (agent.quarantined || agent.paused) throw new PapError("agent_paused");
    const box: BoxRef = { kind: "agent", id: agentId };
    // The thread VM's own link: `phase()` also answers for an isolated task VM of the same agent, which has no files to browse.
    if (deps.runtime.link(box) !== undefined) return;
    const launch = deps.launches.open({ box, owner: ownerId, for: "start" });
    let code: string | undefined;
    try {
      await stepAround(launch, "checks", () => deps.gate(box, launch));
      const image = await imageStep(launch, (observe) =>
        Promise.resolve(deps.imageTagOf(agentId, agent.input, "thread", observe)),
      );
      deps.recheck(ownerId, agentId);
      if (deps.disabled(box)) throw new PapError("account_disabled");
      await deps.runtime.start({
        box,
        kind: "thread",
        taskKey: null,
        image,
        resources: agent.input.resources,
        launch,
      });
    } catch (error) {
      code = launchCodeOf(error);
      throw error;
    } finally {
      launch.end(code === undefined, code);
    }
  }

  return (ownerId, agentId) => {
    const key = `${ownerId}\u0000${agentId}`;
    const live = starting.get(key);
    if (live !== undefined) return live;
    const run: Promise<void> = bringUp(ownerId, agentId).finally(() => {
      if (starting.get(key) === run) starting.delete(key);
    });
    starting.set(key, run);
    return run;
  };
}

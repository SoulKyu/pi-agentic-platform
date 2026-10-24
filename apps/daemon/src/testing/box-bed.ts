import { type ProjectView, TriggerInput } from "@pap/contracts";
import { createTrigger, rows } from "../security/testing/automation-bed.ts";
import { markOf, waitIdle } from "../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "./vm-bed.ts";

export interface BoxBed extends VmBed {
  /** `projects.create`: a box project (its box is not started). */
  createProject(name: string): Promise<ProjectView>;
  /** `projects.startBox` and the wait for the phase `running` on the shell stream's answer. */
  startBox(projectId: string): Promise<void>;
  /** `sessions.create` in the project's folder, subscribed. */
  openSession(root: string): Promise<string>;
  /** `sessions.prompt` and the wait for the run to end. */
  prompt(sessionId: string, text: string): Promise<void>;
  /** A manual trigger whose folder is the project's, fired once; resolves with the task id. */
  fireTask(root: string, execution?: Record<string, unknown>): Promise<{ triggerId: string; taskId: string }>;
  /** The task's state in the database now. */
  taskState(taskId: string): string | undefined;
}

/**
 * A whole daemon on the process backend (the guest and its pi-host worker as local processes, a scripted model) with the helpers
 * the boxes journeys share: everything goes over RPC, as the web does.
 */
export async function startBoxBed(
  script: object,
  options: Parameters<typeof startVmBed>[1] = {},
): Promise<BoxBed> {
  const bed = await startVmBed(script, options);
  return Object.assign(bed, {
    async createProject(name: string) {
      const { project } = await bed.call<{ project: ProjectView }>("projects.create", { name });
      return project;
    },
    async startBox(projectId: string) {
      await bed.call("projects.startBox", { projectId });
    },
    async openSession(root: string) {
      const { sessionId } = await bed.call<{ sessionId: string }>("sessions.create", { cwd: root });
      await bed.call("subscribe.session", { sessionId });
      return sessionId;
    },
    async fireTask(root: string, execution: Record<string, unknown> = {}) {
      const { id: triggerId } = await createTrigger(
        bed.owner.client,
        TriggerInput.parse({
          name: "Report",
          source: { type: "manual" },
          execution: { cwd: root, tools: ["read", "write"], ...execution },
          prompt: "Write the report.",
        }),
      );
      const fired = await bed.call<{ verdict: string; taskId?: string }>("automation.fire", { triggerId });
      if (fired.verdict !== "fired" || fired.taskId === undefined)
        throw new Error(`not fired: ${fired.verdict}`);
      return { triggerId, taskId: fired.taskId };
    },
    taskState: (taskId: string) =>
      rows<{ state: string }>(bed.t.home, "SELECT state FROM tasks WHERE id = ?", taskId)[0]?.state,
    async prompt(sessionId: string, text: string) {
      const mark = markOf(bed.owner.client);
      await bed.call("sessions.prompt", { sessionId, text });
      await waitIdle(bed.owner.client, mark);
    },
  });
}

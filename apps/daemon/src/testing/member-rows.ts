import { AgentInput, type MethodName, type ProjectView, TriggerInput } from "@pap/contracts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { rows } from "../security/testing/automation-bed.ts";
import type { Person, TwoUsers } from "./two-users.ts";

export const ask = async <T>(who: Person, method: string, params: object): Promise<T> => {
  const frame = await who.call(method as MethodName, params as never);
  if (!frame.ok) throw new Error(`${method}: ${frame.error.code}`);
  return frame.result as T;
};

/** A member's agent with a schedule trigger on its thread, a started box with a session that ran once. */
export async function giveRows(u: TwoUsers, who: Person, schedule = true) {
  const { project } = await ask<{ project: ProjectView }>(who, "projects.create", { name: "Garden" });
  await ask(who, "projects.startBox", { projectId: project.id });
  const { sessionId } = await ask<{ sessionId: string }>(who, "sessions.create", { cwd: project.root });
  await ask(who, "subscribe.session", { sessionId });
  await ask(who, "sessions.prompt", { sessionId, text: "tend the garden" });
  await vi.waitFor(
    () =>
      expect(
        rows<{ n: number }>(u.bed.t.home, "SELECT count(*) AS n FROM runs WHERE owner_id = ?", who.id)[0]?.n,
      ).toBeGreaterThan(0),
    { timeout: 30_000 },
  );
  const agent = await ask<{ id: string }>(who, "agents.create", {
    input: AgentInput.parse({
      name: `Atlas${who.name}`,
      mode: "full-access",
      preset: "full",
      sandbox: { required: true, network: true },
    }),
  });
  await ask(who, "agents.openThread", { agentId: agent.id });
  const trigger = schedule
    ? await ask<{ trigger: { id: string } }>(who, "automation.triggers.create", {
        input: TriggerInput.parse({
          name: "Round",
          enabled: true,
          source: { type: "schedule", rrule: "FREQ=MINUTELY;INTERVAL=5", timezone: "UTC", catchUp: "once" },
          execution: { agent: { agentId: agent.id, target: "thread" } },
          prompt: "Take the round.",
        }),
      })
    : null;
  return { project, sessionId, agentId: agent.id, triggerId: trigger?.trigger.id ?? "" };
}

/** The rows of `table` whose `owner_id` (or `user_id`) is `id`. */
export function countOf(home: string, table: string, id: string): number {
  const column = rows<{ name: string }>(home, `SELECT name FROM pragma_table_info('${table}')`).some(
    (info) => info.name === "owner_id",
  )
    ? "owner_id"
    : "user_id";
  return rows<{ n: number }>(home, `SELECT count(*) AS n FROM "${table}" WHERE ${column} = ?`, id)[0]?.n ?? 0;
}

/** The files below `dir` that hold `text`. */
export function filesHolding(dir: string, text: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => readFileSync(path, "utf8").includes(text));
}

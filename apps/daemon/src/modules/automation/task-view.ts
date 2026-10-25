import type { TaskView, Waiting } from "@pap/contracts";
import type { PolicyPort } from "../policy/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { detailOf, isTerminal, type TaskJoined } from "./tasks.ts";

const NOTE_UNITS = 200;
const REMINDER_FENCE =
  /^<untrusted source="reminder" id="[0-9a-f]+">\n([\s\S]*)\n<\/untrusted id="[0-9a-f]+">$/;

/** The note of a reminder, read back from its fenced prompt and clipped to 200 UTF-16 units (never half a pair). */
function reminderNote(prompt: string): string | null {
  const note = REMINDER_FENCE.exec(prompt)?.[1];
  if (note === undefined) return null;
  if (note.length <= NOTE_UNITS) return note;
  let end = NOTE_UNITS - 1;
  const last = note.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${note.slice(0, end)}\u2026`;
}

export interface TaskViewDeps {
  readonly sessions: Pick<SessionsAutomationPort, "state">;
  readonly runs: Pick<RunsPort, "sessionCost" | "limitResetAt">;
  readonly policy: Pick<PolicyPort, "sessionPolicy">;
  /** A thread task shares its session with the others: its cost is that of its own runs (M11R71). */
  readonly threadCost?: (taskId: string) => number;
  /** What a queued task waits for now (launch progress); none until the engine says. */
  readonly waiting?: (taskId: string) => Waiting | null;
}

/** A stored row as the board shows it: the live parts (a waiting question, the cost, the tool list) are read now. */
export function createTaskViews(deps: TaskViewDeps) {
  return function viewOf(row: TaskJoined): TaskView {
    const sessionId = row.session_id;
    const live = sessionId === null ? null : deps.sessions.state(row.owner_id, sessionId);
    const policy = sessionId === null ? null : deps.policy.sessionPolicy(row.owner_id, sessionId);
    return {
      id: row.id,
      triggerId: row.trigger_id,
      triggerName: row.trigger_name ?? row.title,
      projectId: row.project_id,
      state: row.state,
      reason: row.reason,
      origin: row.origin,
      title: row.title,
      // Stored clipped already; clipped again here so a row an older build wrote cannot reach a client unclipped.
      detail: detailOf(row.detail),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      sessionId,
      // A thread outlives its task: a question the owner has not answered there is not the finished task's.
      needsInput: !isTerminal(row.state) && (live?.needsInput ?? false),
      costUsd:
        row.target === "thread"
          ? (deps.threadCost?.(row.id) ?? 0)
          : sessionId === null
            ? 0
            : (deps.runs.sessionCost(sessionId) ?? 0),
      // Read from the run that hit the quota (persisted), so a restart loses nothing.
      resetAt: row.state === "limited" && sessionId !== null ? deps.runs.limitResetAt(sessionId) : null,
      toolsReleased:
        isTerminal(row.state) && policy !== null && policy.recorded && policy.toolAllowlist === null,
      agentId: row.agent_id,
      target: row.target,
      // A reminder inherits `requested_by` to forbid a second delegation (RT-16); only a delegation has a requester to show.
      requestedBy: row.origin === "delegate" ? row.requested_by : null,
      // A reminder's time and note (W1); the note is the agent's own text.
      notBefore: row.origin === "remind" ? row.not_before : null,
      note: row.origin === "remind" ? reminderNote(row.prompt) : null,
      waiting: row.state === "queued" ? (deps.waiting?.(row.id) ?? null) : null,
    };
  };
}
export type TaskViews = ReturnType<typeof createTaskViews>;

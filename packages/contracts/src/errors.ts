export const ERROR_CODES = [
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "capacity",
  "worker_failed",
  "timeout",
  "prompt_rejected",
  "invalid_cwd",
  "queue_full",
  "session_busy",
  "session_empty",
  "command_failed",
  "limit_reached",
  "step_up_required",
  "read_only",
  "protected_path",
  "terminal_unavailable",
  "helper_failed",
  "project_scope",
  "config_invalid",
  "config_path_refused",
  "config_hard_link",
  "automation_paused",
  "budget_reached",
  "disk_low",
  "sandbox_unavailable",
  "agent_paused",
  "push_unavailable",
  "push_revoked",
  "network",
  "extensions_failed",
  "unknown_method",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** What the launch gate of an agent session can refuse with (M11R53, M11R182): declared by every method that can start a worker. */
export const AGENT_GATE_ERRORS = [
  "sandbox_unavailable",
  "agent_paused",
  "invalid_cwd",
] as const satisfies readonly ErrorCode[];

export const ERROR_MESSAGES: { readonly [C in ErrorCode]: string } = {
  bad_request: "The request is invalid.",
  unauthenticated: "Sign in first.",
  forbidden: "You do not have permission for this action.",
  not_found: "Not found.",
  conflict: "This already exists or changed meanwhile.",
  rate_limited: "Too many attempts. Try again later.",
  payload_too_large: "The request is too large.",
  capacity: "The server is at capacity. Try again later.",
  worker_failed: "The session process failed.",
  timeout: "The session process did not answer in time.",
  prompt_rejected: "The session could not start this prompt. Check the model and provider settings.",
  invalid_cwd: "The working directory must be an absolute path to an existing folder.",
  queue_full: "Too many messages are waiting in this session. Wait for the agent, or clear the queue.",
  session_busy: "The session is working. Wait for it to finish, or stop it first.",
  session_empty: "This session has no messages to work with yet.",
  command_failed: "The session could not complete this command.",
  limit_reached: "This list is full. Remove an entry first.",
  step_up_required: "Confirm your password to continue.",
  read_only: "The database was written by a newer version and is read-only.",
  protected_path:
    "This file can run commands later, such as a git hook or an editor task. Confirm to save it.",
  terminal_unavailable: "Terminals are not available on this server: the terminal module did not load.",
  helper_failed: "The Pi configuration helper failed.",
  project_scope: "This project sets its own value in .pi/settings.json, which wins over the global one.",
  config_invalid: "A Pi configuration file is not valid. Fix the file, then try again.",
  config_path_refused: "Pi refused this configuration path: it must be a regular file inside your folders.",
  config_hard_link:
    "Pi refused to write this file because it has another hard link. Replace it with a regular copy, then try again.",
  automation_paused: "Automation is paused. Resume it on the Tasks board or in Settings › Automation.",
  budget_reached:
    "Today's automation budget is spent. Raise it in Settings › Automation, or wait for tomorrow.",
  disk_low:
    "The disk is almost full: pap keeps some space free for its database. Free some space, then try again.",
  sandbox_unavailable: "This agent's sandbox cannot run on this server as set up. See Settings › Agents.",
  agent_paused: "This agent is paused. Resume it from its header.",
  push_unavailable: "Notifications are not available on this server. See Settings › Notifications.",
  push_revoked:
    "This device was removed from the notification list. Enable notifications again to add it back.",
  network: "pap could not fetch this from the network.",
  extensions_failed: "An extension did not load: nothing was changed.",
  unknown_method: "Unknown method.",
  internal: "Internal error.",
};

/** Workers in use against the cap: the numbers behind a `capacity` refusal, shown as "n / n workers". */
export interface WorkerCounts {
  readonly used: number;
  readonly max: number;
}

export class PapError extends Error {
  readonly code: ErrorCode;
  /** Additive detail for a `capacity` refusal; absent when the daemon did not count (a closing server). */
  readonly workers?: WorkerCounts;

  constructor(code: ErrorCode, detail?: { readonly workers?: WorkerCounts }) {
    super(ERROR_MESSAGES[code]);
    this.name = "PapError";
    this.code = code;
    if (detail?.workers) this.workers = detail.workers;
  }
}

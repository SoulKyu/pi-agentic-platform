import { commandsEn } from "./catalog/commands.ts";
import { devEn } from "./catalog/dev.ts";
import { launchEn } from "./catalog/launch.ts";
import { shellEn } from "./catalog/shell.ts";

// A build-time constant: production drops the branch and the key with it. The cast keeps the key in `MessageKey`.
const dev = (import.meta.env.DEV ? devEn : {}) as typeof devEn;

export const en = {
  ...shellEn,
  ...commandsEn,
  ...launchEn,
  ...dev,
  "app.name": "pap",
  "app.tagline": "pi agentic platform",
  "app.loading": "Loading…",
  "gate.retry": "Retry",
  "setup.title": "Create the owner account",
  "setup.username": "Username",
  "setup.password": "Password",
  "setup.usernameHint": "Letters, digits, dot, dash and underscore; up to 64.",
  "setup.passwordHint": "At least 12 characters.",
  "setup.submit": "Create account",
  "setup.missingToken": "Open the setup link printed in the server log.",
  "login.title": "Sign in",
  "login.submit": "Sign in",
  "login.passkey": "Sign in with a passkey",
  "login.throttleNote":
    "Each failed attempt doubles the wait before the next one, from 1 second up to 1 minute, per address and per account. A browser that has signed in before has a limit of its own. It resets after 5 minutes without a failure.",
  "login.failed": "Wrong username or password.",
  "login.throttled": "Too many attempts. Wait {seconds} s.",
  "account.addPasskey": "Add a passkey",
  "account.passkeyPasswordHint": "Enter your password to add a passkey.",
  "account.passkeyAdded": "Passkey added.",
  "account.cancel": "Cancel",
  "session.composer": "Message",
  "session.failure": "Model error",
  "session.omitted": "Message too large to show ({size} KB).",
  "session.status.cold": "Stopped",
  "session.status.starting": "Starting",
  "session.status.idle": "Ready",
  "session.status.running": "Working",
  "author.you": "You",
  "author.agent": "Agent",
  "author.tool": "Tool",
  "connection.outdated": "A new version of pap is available. Reload the page.",
  "connection.silent": "The daemon is not answering.",
  "connection.retryIn": "Retrying in {seconds} s",
  "connection.retry": "Retry",
  "connection.reconnecting": "Reconnecting…",
  "error.bad_request":
    "pap refused this request: a value is missing or out of range. Nothing was changed. Check the fields and try again.",
  "error.unauthenticated": "Sign in first.",
  "error.forbidden": "You do not have permission for this action.",
  "error.not_found":
    "This item no longer exists: it was deleted, or the link is wrong. Nothing else was changed. Pick it again from its list.",
  "error.conflict":
    "This changed in the meantime, or it already exists. Your version was not saved. Reload, then make your change again.",
  "error.rate_limited": "Too many attempts. Try again later.",
  "error.payload_too_large": "The message is too large.",
  "error.capacity":
    "pap is at capacity: every worker slot is in use. Nothing was started. Try again when a session finishes, or stop one.",
  "error.capacityWorkers": "{used} / {max} workers running.",
  "error.worker_failed": "The session process stopped. The transcript is intact. Send again to restart it.",
  "error.stopped": "Stopped.",
  "error.timeout":
    "The session did not answer in time. The action may still have gone through: check before trying again.",
  "error.prompt_rejected": "The session could not start this prompt. Check the model and provider settings.",
  "error.invalid_cwd": "The working directory must be an absolute path to an existing folder.",
  "error.step_up_required": "Confirm your password to continue.",
  "error.read_only":
    "A newer pap wrote this database, so this one opened it read-only. Nothing was changed. Update pap to use it again.",
  "error.unknown_method": "This version of the page does not match the server. Reload it.",
  "error.internal":
    "pap hit an unexpected error. The action may not have completed: check its result, then try again. If it repeats, run pap doctor.",
  "error.connection_lost":
    "The connection dropped before the answer arrived. The action may still have gone through: check before trying again.",
  "error.offline":
    "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry.",
  "error.passkey_cancelled": "The passkey prompt was cancelled.",
  "error.passkey_failed": "The passkey could not be used. Try again, or use your password.",
  "error.password_incorrect": "Password incorrect.",
  "error.queue_full":
    "Too many messages are waiting in this session. Wait for the agent, or clear the queue.",
  "error.session_busy": "The session is working. Wait for it to finish, or stop it first.",
  "error.session_empty": "This session has no messages to work with yet.",
  "error.command_failed": "The session could not complete this command.",
  "session.status.releasing": "Releasing",
  // ── session screen in the shell (P3) ──
  "sessions.announce.runEnded": "The agent has finished.",
  "sessions.announce.approval": "The agent is waiting for your approval.",
  "sessions.transcript.thought": "Thought",
  "sessions.code.copy": "Copy code",
  "sessions.code.copied": "Copied",
  "sessions.transcript.label": "Conversation",
  "session.status.needsInput": "Needs you",
  "row.actions": "Message actions",
  "branch.group": "Branch {index} of {total}",
  "connection.draftsStay": "Your drafts stay on this device.",
} as const;

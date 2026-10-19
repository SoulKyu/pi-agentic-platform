import { randomBytes } from "node:crypto";
import { type AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import { type InitRecord, PolicyRules, type UiResponseRecord } from "@pap/contracts";
import { createApprovals } from "./approvals.ts";
import { type Command, createDispatch } from "./dispatch.ts";
import { createEntryTracker, type EntryTracker } from "./entry-tracker.ts";
import { countAgentProcesses, killDetachedDescendants, TOKEN_VAR, UNIT_VAR } from "./descendants.ts";
import { pinBareRepositoryExplicit } from "./git-env.ts";
import { createInbox } from "./inbox-put.ts";
import type { Ipc } from "./ipc.ts";
import { loadoutRecord } from "./loadout.ts";
import { createOnceSecrets, createVaultSink, withOnceSecrets } from "./once-secrets.ts";
import { openSession } from "./open-session.ts";
import { createPlatformPort } from "./platform-tools.ts";
import { auditSinkOf } from "./policy/audit-sink.ts";
import { redactingAuditSink } from "./policy/results.ts";
import { NO_REDACTOR } from "./policy/redact.ts";
import { appendMidRunUntrusted } from "./memory-entry.ts";
import { createTaint } from "./policy/taint.ts";
import { createSecretSource, type SecretSource } from "./policy/secrets.ts";
import { createRedactingIpc } from "./redacting-ipc.ts";
import { redactStdio, type Writable } from "./redact-stdio.ts";
import { createDeltaGate } from "./delta-gate.ts";
import { createEgressClient } from "./egress-client.ts";
import { createSandboxEnvironment } from "./sandbox-env.ts";
import { SYSTEM_TIMERS } from "./sandbox-ops.ts";
import { createIsBuiltin } from "./policy/builtin-lookup.ts";
import { createSessionEntries } from "./policy/session-entry.ts";
import { createSessionMirror, openUnderRoot, type SessionMirror } from "./session-mirror.ts";
import { closeSession } from "./shutdown.ts";
import { createUiBridge } from "./ui-bridge.ts";
import { logLineOf } from "./bounded.ts";
import { toExtensionErrorRecord, toWireEvent } from "./wire-events.ts";

const HEALTH_INTERVAL_MS = 30_000;
/** How long a shutdown waits for a running agent to stop: the first step of the daemon's kill ladder (spec C §2.5). */
const DEFAULT_GRACE_MS = 2000;
/** The daemon sends few records before ready; more than this is a bug, not a queue to grow. */
const MAX_EARLY_RECORDS = 128;

// Every way the worker ends on its own terms comes through here. What the session's dispose does not stop (a
// command in a session of its own, a grandchild of one) is killed first: once dispose has killed a command's
// shell, the shell's own children have a new parent and are no longer found below this process.
function exit(session: AgentSession | null, code: number): never {
  killDetachedDescendants();
  try {
    session?.dispose();
  } finally {
    process.exit(code);
  }
}

export async function runHost(rawIpc: Ipc): Promise<void> {
  // Until the session knows its secrets nothing is redacted; the first records are small ones the worker made itself.
  let secrets: SecretSource | null = null;
  // Every sender below uses `ipc`: each record leaves through the redaction (M5R36). Receiving stays on the raw channel.
  const ipc = createRedactingIpc(
    rawIpc,
    () => secrets?.current() ?? NO_REDACTOR,
    // The same classification stage 06 uses on a result: only Pi's own tool of that name (M5R116).
    createIsBuiltin(() => session?.getAllTools()),
  );
  // A marker for this worker alone, before Pi starts: the shells its tools run inherit the environment, so a process the
  // agent leaves running keeps it after Linux has given it to pid 1, and the count can find it without a scope (M2R107).
  process.env[TOKEN_VAR] = randomBytes(16).toString("hex");
  // MC18: for every git the agent runs; a throw (an unreadable GIT_CONFIG_COUNT) ends the worker before any tool runs.
  pinBareRepositoryExplicit(process.env);
  // The scope the daemon started this worker in. Taken out of the environment so no process below inherits it: a worker
  // an agent starts inside this one is not in a scope of the daemon's and must not count this one's.
  const unit = process.env[UNIT_VAR];
  Reflect.deleteProperty(process.env, UNIT_VAR);
  let session: AgentSession | null = null;
  let dispatch: ((record: Command) => void) | null = null;
  const early: Command[] = [];
  // Created once the session exists; what Pi emits while it opens is before the leaf `ready` reports.
  let tracker: EntryTracker | null = null;
  // Only a worker in a VM mirrors its session file to the daemon (T9a).
  let mirror: SessionMirror | null = null;
  const ui = createUiBridge((record) => ipc.send(record));
  const approvals = createApprovals((record) => ipc.send(record));
  const platform = createPlatformPort((record) => ipc.send(record));
  let receiveInit: (record: InitRecord) => void = () => {};
  let failInit: (error: Error) => void = () => {};
  const init = new Promise<InitRecord>((resolve, reject) => {
    receiveInit = resolve;
    failInit = reject;
  });
  let closing = false;
  // Cancels the dialogs, stops the running agent and tells extensions (both bounded by the grace), then disposes the session and exits.
  const shutdown = (graceMs: number) => {
    if (closing) return;
    closing = true;
    ui.cancelAll();
    approvals.cancelAll();
    // Before the abort, for the same reason: aborting kills the shell of a running command and orphans its children.
    killDetachedDescendants();
    const current = session;
    if (!current) exit(null, 0);
    const finish = () => exit(current, 0);
    void closeSession(current, graceMs, undefined, undefined, () => mirror?.close()).then(finish, finish);
  };
  // One listener from the first record on, so nothing sent while the session opens is lost: records after
  // `init` wait here until the session is ready, then run in order.
  rawIpc.onMessage(
    (record) => {
      if (record.type === "init") receiveInit(record);
      else if (record.type === "shutdown") shutdown(record.graceMs);
      else if (closing) return;
      else if (dispatch) dispatch(record);
      else if (early.length >= MAX_EARLY_RECORDS) {
        process.stderr.write(
          `pi-host: more than ${MAX_EARLY_RECORDS} records before ready: refusing to start\n`,
        );
        exit(session, 70);
      } else early.push(record);
    },
    (raw) => {
      // A record the worker cannot read must not leave its sender waiting: a bad init stops the worker, a bad
      // answer cancels its dialog, a shutdown always shuts down, and a bad command gets a failure response.
      const { type, id } = (typeof raw === "object" && raw !== null ? raw : {}) as {
        type?: unknown;
        id?: unknown;
      };
      if (type === "init") failInit(new Error("the init record is malformed: refusing to start"));
      else if (type === "shutdown") shutdown(DEFAULT_GRACE_MS);
      else if (type === "extension_ui_response") ui.resolve(raw as UiResponseRecord);
      else if (type === "approval_response" && typeof id === "string") {
        approvals.resolve({ id, answer: "deny", cancelled: true });
      } else if (typeof type === "string" && typeof id === "string") {
        ipc.send({
          type: "response",
          id,
          command: type.slice(0, 64),
          success: false,
          error: "malformed record",
        });
      }
    },
  );
  rawIpc.onDisconnect(() => exit(session, 0));

  const initial = await init;
  const first = PolicyRules.safeParse(initial.policy);
  if (!first.success) throw new Error("the init record carries invalid policy rules: refusing to start");
  // `null` after a malformed update: every call blocks (M5R11). Both are assigned in one synchronous step below,
  // so the pipeline, which reads the version and the rules without awaiting between them, never sees one moved alone.
  let rules: PolicyRules | null = first.data;
  // Moves on every policy update, a malformed one too: provisional "always" grants end with it (M2R73).
  let rulesVersion = 0;
  const reportTaint = () => {
    if (!ipc.send({ type: "taint", epoch: taint.state().epoch }))
      process.stderr.write("pi-host: taint record not sent; the next agent_end repeats it\n");
  };
  // M11R143: a worker that started untainted notes, once, that its session is untrusted from now on. No pi-mem0 reads
  // this entry today: it is for a future one that checks it at capture time. The barrier is the daemon, which releases
  // this worker (and restarts it before the next prompt). Raised before the session exists, the note is written at once
  // when it does (`session = opened` below).
  let midRunNoted = first.data.taint.tainted;
  let noteWanted = false;
  const noteMidRun = () => {
    if (midRunNoted) return;
    if (!session) {
      noteWanted = true;
      return;
    }
    midRunNoted = true;
    appendMidRunUntrusted(session.sessionManager);
  };
  const taint = createTaint(first.data.taint, () => {
    reportTaint();
    noteMidRun();
  });
  const entries = createSessionEntries((record) => ipc.send(record), initial.sandbox);
  // Before anything creates a file: the daemon's own 077 is for its state, not for the user's projects (R114).
  process.umask(initial.umask);
  const source = createSecretSource({ env: process.env, agentDir: initial.agentDir });
  secrets = source;
  // "Use once" (M11R105): the first sandboxed command that names `$NAME` gets the value, then `secret_used` tells the daemon.
  const once = createOnceSecrets({
    used: ({ name, id }) => {
      if (!ipc.send({ type: "secret_used", name, id }))
        process.stderr.write("pi-host: secret_used not sent\n");
    },
  });
  const sandboxEnvironment = initial.sandbox
    ? withOnceSecrets(createSandboxEnvironment(process.env, initial.sandbox, initial.vault ?? {}), once)
    : undefined;
  // Only a networked agent sandbox asks the daemon for a proxy socket per command (M11R232).
  const egress = initial.sandbox?.egress
    ? createEgressClient((record) => ipc.send(record), SYSTEM_TIMERS)
    : undefined;
  const vaultSink = createVaultSink({ source, environment: sandboxEnvironment, once });
  // From the first byte of output: the vault is redacted even when no sandbox gives it to a shell (M11R26).
  vaultSink.update({ vault: initial.vault ?? {}, once: initial.once ?? [] });
  for (const stream of [process.stdout, process.stderr])
    redactStdio(stream as unknown as Writable, () => source.current());
  // W5-R60: the pieces of what the model types leave redacted, a value cut across them included.
  const deltaGate = createDeltaGate(() => source.current());
  const sendAudit = auditSinkOf((record) => ipc.send(record));
  const opened = await openSession(initial, {
    secrets: source,
    ...(sandboxEnvironment ? { sandboxEnvironment } : {}),
    ui,
    approvals,
    platform: platform.port,
    ...(egress ? { egress } : {}),
    rules: () => rules,
    rulesVersion: () => rulesVersion,
    taint,
    audit: redactingAuditSink(sendAudit, source),
    onAgentStart: (names) => entries.agentStart(names, rules?.approvalMode ?? first.data.approvalMode),
    onEvent: (event) => {
      for (const record of deltaGate.apply(toWireEvent(event))) ipc.send(record);
      tracker?.observe(event);
      if (event.type === "agent_end" && taint.current()) reportTaint();
    },
    onExtensionError: (error) => ipc.send(toExtensionErrorRecord(error)),
    sendLoadout: (record) => ipc.send(record),
  });
  session = opened;
  if (noteWanted) noteMidRun();
  entries.opened(opened.getActiveToolNames(), first.data.approvalMode);
  const vm = initial.vm;
  if (vm) {
    mirror = createSessionMirror({
      file: () => opened.sessionFile ?? null,
      send: (record) => ipc.send(record),
      open: openUnderRoot(vm.layout.root),
      clock: {
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      },
      log: (line) => void process.stderr.write(line),
    });
  }
  tracker = createEntryTracker({
    manager: opened.sessionManager,
    send: (record) => ipc.send(record),
    defer: (task) => void setImmediate(task),
    onError: (error) => process.stderr.write(`pi-host: entry tracking failed: ${logLineOf(error)}\n`),
    afterWalk: () => mirror?.flush(),
  });
  dispatch = createDispatch({
    papHome: initial.papHome,
    session: opened,
    leafMayHaveMoved: () => tracker?.leafMayHaveMoved(),
    ...(mirror ? { mirror } : {}),
    ...(vm ? { vm: true } : {}),
    ...(vm ? { inbox: createInbox(vm.layout.inbox), inboxDir: vm.layout.inbox } : {}),
    ipc,
    ui,
    approvals,
    platform,
    vault: { update: (record) => vaultSink.update(record) },
    ...(egress ? { egress } : {}),
    setRules: (next) => {
      rules = next;
      rulesVersion++;
    },
    applyTaint: (update) => {
      taint.apply(update);
      if (taint.current()) noteMidRun();
    },
  });
  ipc.send({
    type: "ready",
    sessionFile: opened.sessionFile ?? "",
    sessionId: opened.sessionId,
    piVersion: VERSION,
    leafId: opened.sessionManager.getLeafId(),
    sessionName: opened.sessionName ?? null,
  });
  ipc.send(loadoutRecord(opened));
  mirror?.flush();
  for (const record of early.splice(0)) dispatch(record);
  const health = () =>
    ipc.send({
      type: "health",
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      descendants: countAgentProcesses({ unit }),
    });
  health();
  setInterval(health, HEALTH_INTERVAL_MS).unref();
}

import { type AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import { type InitRecord, PolicyRules, type UiResponseRecord } from "@pap/contracts";
import { type Command, createDispatch } from "./dispatch.ts";
import { killDetachedDescendants } from "./descendants.ts";
import type { Ipc } from "./ipc.ts";
import { openSession } from "./open-session.ts";
import { createUiBridge } from "./ui-bridge.ts";
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

export async function runHost(ipc: Ipc): Promise<void> {
  let session: AgentSession | null = null;
  let dispatch: ((record: Command) => void) | null = null;
  const early: Command[] = [];
  const ui = createUiBridge((record) => ipc.send(record));
  let receiveInit: (record: InitRecord) => void = () => {};
  let failInit: (error: Error) => void = () => {};
  const init = new Promise<InitRecord>((resolve, reject) => {
    receiveInit = resolve;
    failInit = reject;
  });
  let closing = false;
  // Stops the running agent (bounded by the grace), cancels the dialogs, then disposes the session and exits.
  const shutdown = (graceMs: number) => {
    if (closing) return;
    closing = true;
    ui.cancelAll();
    // Before the abort, for the same reason: aborting kills the shell of a running command and orphans its children.
    killDetachedDescendants();
    const current = session;
    if (!current) exit(null, 0);
    const finish = () => exit(current, 0);
    const grace = new Promise((resolve) => setTimeout(resolve, graceMs));
    void Promise.race([current.abort().catch(() => {}), grace]).then(finish, finish);
  };
  // One listener from the first record on, so nothing sent while the session opens is lost: records after
  // `init` wait here until the session is ready, then run in order.
  ipc.onMessage(
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
      else if (typeof type === "string" && typeof id === "string") {
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
  ipc.onDisconnect(() => exit(session, 0));

  const initial = await init;
  const first = PolicyRules.safeParse(initial.policy);
  if (!first.success) throw new Error("the init record carries invalid policy rules: refusing to start");
  let rules: PolicyRules = first.data;
  // Before anything creates a file: the daemon's own 077 is for its state, not for the user's projects (R114).
  process.umask(initial.umask);
  const opened = await openSession(initial, {
    ui,
    rules: () => rules,
    audit: (entry) => ipc.send({ type: "audit", entry }),
    onEvent: (event) => ipc.send(toWireEvent(event)),
    onExtensionError: (error) => ipc.send(toExtensionErrorRecord(error)),
  });
  session = opened;
  dispatch = createDispatch({
    session: opened,
    ipc,
    ui,
    rules: () => rules,
    setRules: (next) => {
      rules = next;
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
  for (const record of early.splice(0)) dispatch(record);
  const health = () => ipc.send({ type: "health", rssMb: Math.round(process.memoryUsage().rss / 1048576) });
  health();
  setInterval(health, HEALTH_INTERVAL_MS).unref();
}

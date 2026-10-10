import { type AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import { type DaemonToWorker, type InitRecord, PolicyRules, type UiResponseRecord } from "@pap/contracts";
import { handleAbort, handleGetState, handlePrompt } from "./commands.ts";
import type { Ipc } from "./ipc.ts";
import { openSession } from "./open-session.ts";
import { POLICY_EXTENSION_PATH } from "./policy/extension.ts";
import { createUiBridge } from "./ui-bridge.ts";
import { toWireEvent } from "./wire-events.ts";

const HEALTH_INTERVAL_MS = 30_000;

type Command = Exclude<DaemonToWorker, { type: "init" | "shutdown" }>;

function exit(session: AgentSession | null, code: number): never {
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
  // One listener from the first record on, so nothing sent while the session opens is lost: records after
  // `init` wait here until the session is ready, then run in order.
  ipc.onMessage(
    (record) => {
      if (record.type === "init") receiveInit(record);
      else if (record.type === "shutdown") {
        ui.cancelAll();
        exit(session, 0);
      } else if (dispatch) dispatch(record);
      else early.push(record);
    },
    (raw) => {
      // A record the worker cannot read must not leave its sender waiting: a bad init stops the worker, a bad
      // answer cancels its dialog, and a bad command gets a failure response.
      const { type, id } = (typeof raw === "object" && raw !== null ? raw : {}) as {
        type?: unknown;
        id?: unknown;
      };
      if (type === "init") failInit(new Error("the init record is malformed: refusing to start"));
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
  const opened = await openSession(initial, {
    ui,
    rules: () => rules,
    audit: (entry) => ipc.send({ type: "audit", entry }),
    onEvent: (event) => ipc.send(toWireEvent(event)),
    onExtensionError: (error) => ipc.send({ type: "extension_error", ...error }),
  });
  session = opened;
  dispatch = (record) => {
    switch (record.type) {
      case "prompt":
        handlePrompt(opened, record, ipc.send);
        return;
      case "abort":
        void handleAbort(opened, record, ipc.send);
        return;
      case "get_state":
        handleGetState(opened, record, ipc.send);
        return;
      case "extension_ui_response":
        ui.resolve(record);
        return;
      case "policy_update": {
        const update = PolicyRules.safeParse(record.rules);
        if (update.success) {
          rules = update.data;
        } else {
          ipc.send({
            type: "extension_error",
            extensionPath: POLICY_EXTENSION_PATH,
            event: "policy_update",
            error: "invalid policy rules: the previous rules stay in force",
          });
        }
        return;
      }
    }
  };
  ipc.send({
    type: "ready",
    sessionFile: opened.sessionFile ?? "",
    sessionId: opened.sessionId,
    piVersion: VERSION,
  });
  for (const record of early.splice(0)) dispatch(record);
  const health = () => ipc.send({ type: "health", rssMb: Math.round(process.memoryUsage().rss / 1048576) });
  health();
  setInterval(health, HEALTH_INTERVAL_MS).unref();
}

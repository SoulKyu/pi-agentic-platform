import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type DaemonToWorker,
  type EgressOpened,
  type EgressReport,
  POLICY_EXTENSION_PATH,
  PolicyRules,
  type PlatformResultRecord,
  type TaintState,
  type VaultUpdateRecord,
} from "@pap/contracts";
import type { Approvals } from "./approvals.ts";
import { errorClass, logLineOf } from "./bounded.ts";
import { handleAutoName } from "./auto-name.ts";
import { handleAbort, handleGetState, queuePrompt } from "./commands.ts";
import type { Ipc } from "./ipc.ts";
import type { HomeResult } from "./home-files.ts";
import type { FilePutResult } from "./inbox-put.ts";
import { readPromptImages } from "./prompt-images.ts";
import { createPromptQueue } from "./prompt-queue.ts";
import { loadoutRecord } from "./loadout.ts";
import { handleGetAvailableModels, handleSetModel, handleSetThinking } from "./model-commands.ts";
import {
  handleClearQueue,
  handleCompact,
  handleExportHtml,
  handleNavigateTree,
  handleSetSessionName,
} from "./session-commands.ts";
import { handleGetCommands } from "./slash-commands.ts";
import { handleSuggestCommit } from "./suggest-commit.ts";
import { handleSetTools } from "./tool-preset-commands.ts";
import { applyPreset, presetOf } from "./tool-presets.ts";
import type { UiBridge } from "./ui-bridge.ts";

export type Command = Exclude<DaemonToWorker, { type: "init" | "shutdown" }>;

export interface DispatchDeps {
  /** The pap data directory: the only place a prompt's images are read from (M8R41). */
  readonly papHome: string;
  readonly session: AgentSession;
  readonly ipc: Ipc;
  readonly ui: UiBridge;
  readonly approvals: Approvals;
  /** Called after a command that may have moved Pi's leaf has answered. */
  leafMayHaveMoved(): void;
  /** `null`: the update was malformed and every call is blocked until a valid one (M5R11). */
  setRules(rules: PolicyRules | null): void;
  /** Settles the platform call a `platform_result` answers (Task 2); absent: results are dropped. */
  readonly platform?: { resolve(record: PlatformResultRecord): void };
  /** Takes a `vault_update` (the redactor and the sandboxed shell's environment); absent, the record is ignored (M11R26). */
  readonly vault?: { update(record: VaultUpdateRecord): void };
  /** A VM session (`init.vm`): R11, no vault value ever enters a VM, so a `vault_update` is dropped. */
  readonly vm?: boolean;
  /** Takes the daemon's answers to `egress_open` / `egress_close` (M11R232); absent, they are dropped. */
  readonly egress?: { opened(record: EgressOpened): void; report(record: EgressReport): void };
  /** The taint of a valid update: a newer epoch replaces the state, the same epoch only raises it (M5R6). */
  applyTaint(taint: TaintState): void;
  /** The transcript mirror of a worker in a VM (T9a): flushed after every response, resent on `session_resync`. */
  /** A worker in a VM takes attachments into its inbox (T10a, R33); absent: `file_put` is ignored. */
  readonly inbox?: { put(chunk: Extract<DaemonToWorker, { type: "file_put" }>): FilePutResult | null };
  /** A worker in a VM takes the owner's imported files into its home (sub-project 2); absent: `home_put` / `home_remove` are ignored. */
  readonly home?: {
    put(chunk: Extract<DaemonToWorker, { type: "home_put" }>): Promise<HomeResult>;
    remove(request: Extract<DaemonToWorker, { type: "home_remove" }>): Promise<HomeResult>;
  };
  /** The real inbox folder of a worker in a VM: where its prompt images are read from (RT-06). */
  readonly inboxDir?: string;
  readonly mirror?: {
    flush(): void;
    resync(request: Extract<DaemonToWorker, { type: "session_resync" }>): void;
  };
}

/** One record, one handler. Long commands are not awaited: the next record must not wait behind a compaction. */
export function createDispatch(deps: DispatchDeps): (record: Command) => void {
  const { session, ipc, ui } = deps;
  let vaultDropLogged = false;
  // AVM-E14: the lines Pi appended go out before the response that refers to them.
  const send = (record: Parameters<Ipc["send"]>[0]) => {
    if (record.type === "response") deps.mirror?.flush();
    return ipc.send(record);
  };
  const readImages: typeof readPromptImages | undefined = deps.inboxDir
    ? (home, images) => readPromptImages(home, images, deps.inboxDir)
    : undefined;
  // The handlers answer their own failures; this only catches a failure after the answer (a throwing `send`).
  const background = (command: string, work: Promise<void>): void => {
    work.catch((error: unknown) =>
      process.stderr.write(`pi-host: ${command} failed after it answered: ${logLineOf(error)}\n`),
    );
  };
  const prompts = createPromptQueue((line) => process.stderr.write(line));
  return (record) => {
    switch (record.type) {
      case "prompt":
        queuePrompt(prompts, session, deps.papHome, record, send, readImages);
        return;
      case "abort":
        prompts.dropWaiting();
        background("abort", handleAbort(session, record, send));
        return;
      case "get_state":
        handleGetState(session, record, send);
        return;
      case "clear_queue":
        handleClearQueue(session, record, send);
        return;
      case "compact":
        background("compact", handleCompact(session, record, send));
        return;
      case "navigate_tree":
        background(
          "navigate_tree",
          handleNavigateTree(session, record, send).then(() => {
            deps.leafMayHaveMoved();
            // Pi restores the tools the branch had: the preset is put back (M7R75).
            if (applyPreset(session, presetOf(session))) send(loadoutRecord(session));
          }),
        );
        return;
      case "set_session_name":
        if (handleSetSessionName(session, record, send)) deps.leafMayHaveMoved();
        return;
      case "export_html":
        background("export_html", handleExportHtml(session, record, send));
        return;
      case "auto_name":
        background(
          "auto_name",
          // The title is a `session_info` entry, which advances the leaf (a look after a refusal finds nothing).
          handleAutoName(session, record, send).then(() => deps.leafMayHaveMoved()),
        );
        return;
      case "suggest_commit":
        background("suggest_commit", handleSuggestCommit(session, record, send));
        return;
      case "get_available_models":
        background("get_available_models", handleGetAvailableModels(session, record, send));
        return;
      case "get_commands":
        handleGetCommands(session, record, send);
        return;
      case "set_model":
        background("set_model", handleSetModel(session, record, send));
        return;
      case "set_thinking_level":
        handleSetThinking(session, record, send);
        return;
      case "set_tools":
        handleSetTools(session, record, send);
        return;
      case "extension_ui_response":
        ui.resolve(record);
        return;
      case "approval_response":
        deps.approvals.resolve(record);
        return;
      case "policy_update": {
        const update = PolicyRules.safeParse(record.rules);
        if (update.success) {
          deps.setRules(update.data);
          deps.applyTaint(update.data.taint);
          return;
        }
        // Fail closed (M5R11): "the previous rules" could still hold a revoked rule or a looser mode.
        deps.setRules(null);
        send({
          type: "extension_error",
          extensionPath: POLICY_EXTENSION_PATH,
          event: "policy_update",
          error: "invalid policy rules: every call is blocked until the next valid update",
        });
        return;
      }
      case "platform_result":
        deps.platform?.resolve(record);
        return;
      case "vault_update":
        if (deps.vm) {
          // Type only, once: the payload holds values.
          if (!vaultDropLogged) process.stderr.write("pi-host: vault_update dropped in a VM session\n");
          vaultDropLogged = true;
          return;
        }
        try {
          deps.vault?.update(record);
        } catch (error) {
          // The class only: a message could quote a value.
          process.stderr.write(`pi-host: vault_update failed (${errorClass(error)})\n`);
        }
        return;
      case "egress_opened":
        deps.egress?.opened(record);
        return;
      case "egress_report":
        deps.egress?.report(record);
        return;
      case "custom_input":
        ui.panelInput(record.id, record.data);
        return;
      case "custom_cancel":
        ui.panelCancel(record.id);
        return;
      case "session_resync":
        deps.mirror?.resync(record);
        return;
      case "file_put":
        {
          const answer = deps.inbox?.put(record);
          if (answer) send(answer);
        }
        return;
      case "home_put":
        void deps.home?.put(record).then(send);
        return;
      case "home_remove":
        void deps.home?.remove(record).then(send);
        return;
      default: {
        // Compile-time guard (M2R81): a command added to the contract without a case here fails the build.
        const unhandled: never = record;
        return void unhandled;
      }
    }
  };
}

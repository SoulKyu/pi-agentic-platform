import type {
  Activity,
  CommandInput,
  DaemonToWorker,
  Dialog,
  DialogResponse,
  Notice,
  Panel,
  PartialMessage,
  PiEvent,
  PromptImageRef,
  QueueView,
  ReadyRecord,
  SessionLoadout,
  SessionStatus,
  SessionStreamEvent,
  StatusEntry,
  Widget,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { ApprovedAnswer } from "./dialogs.ts";
import type { CommandAnswer } from "./live-commands.ts";
import type { RunViewState } from "./run-view.ts";

export interface LiveSessionDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(event: SessionStreamEvent): void;
  record(kind: string, data: unknown): void;
  /** Called after every Pi event, when a run ends and when the worker is gone: the moments Pi's file may have appeared. */
  onActivity(): void;
  onExit(exit: WorkerExit): void;
  /** Pi's name for the session changed (or `ready` said it): already clipped by `nameOf`, never called twice for one name. */
  onName(name: string | null): void;
  /** Idle minutes after which the worker is released (spec C 2.1); 0 or less turns it off. */
  readonly idleMs: number;
  /** A prompt of this session waits for the lanes side (a capture or a restore): the worker is not idle, whatever its status says. */
  held?(): boolean;
  /** After `onExit`: the exit and the end of what the worker printed (the supervisor keeps 8 KiB), unclipped. */
  onWorkerExit?(info: { exit: WorkerExit; outputTail: string }): void;
  /** The worker's policy extension refused a `policy_update`: it blocks every call from then on (M5R11). */
  onPolicyRefused?(): void;
  observe?(event: PiEvent): void;
}

export interface LiveSession {
  readonly ready: Promise<ReadyRecord>;
  status(): SessionStatus;
  rssMb(): number | null;
  pid(): number | undefined;
  /** Where Pi writes (or wrote) this session, from `ready`. It does not exist until the first user message. */
  piFile(): string | undefined;
  /** Pi's id for the session, from `ready`. */
  piSessionId(): string | undefined;
  /** Pi's name for the session as the worker last said it, clipped by `nameOf`; null when it has none. */
  name(): string | null;
  dialogs(): Dialog[];
  /** The extension's status bar entries, widgets, title and open panels; empty once the worker is gone. */
  statuses(): StatusEntry[];
  widgets(): Widget[];
  title(): string | null;
  panels(): Panel[];
  /** The last notices this session published, of every source, oldest first (start-up notices included). */
  notices(): Notice[];
  /** Says a notice now, after any pending deltas, and keeps it in the ring for later subscribers. Pap's notices carry no source. */
  notice(notice: Pick<Notice, "level" | "text" | "code" | "params">): void;
  /** Keystrokes for an open panel: `not_found` when it is not open, `bad_request` for data outside 1..4096 characters. */
  panelInput(id: string, data: string): void;
  /** The reply being written, as the stream has sent it so far (never deltas still pending); null between replies. */
  partial(): PartialMessage | null;
  /** Pi's leaf as far as the daemon knows it (from `ready`, each appended entry, the worker's leaf records); null when unknown. */
  leafId(): string | null;
  /** The model, reasoning level and tools as the worker last said them (M7R44); null until it does. */
  loadout(): SessionLoadout | null;
  /** What a run in progress has produced that the session file does not have yet; null between runs. */
  runView(): RunViewState | null;
  prompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
    images?: readonly PromptImageRef[],
  ): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(): Promise<void>;
  /**
   * The session must not be disturbed by a navigation or a compaction (M2R88): a run is open, Pi compacts, a prompt is
   * on its way (or answered `started` and has no `agent_start` yet), or a navigation or compaction is in flight.
   * Callers check it right before `command`, with no `await` between.
   */
  busy(): boolean;
  /** Sends a session command to the worker now and counts it until it is answered; see `LiveCommands.command`. */
  command(input: CommandInput): Promise<CommandAnswer>;
  /** Commands sent to the worker and not answered yet (Task 20 waits for none before it releases the worker). */
  commandsInFlight(): number;
  /** Pi moved its leaf (a navigation): an id over 128 characters counts as unknown (M2R52). */
  navigated(leafId: string | null): void;
  /** Compaction and automatic retry as Pi last said them. */
  activity(): Activity;
  /** What Pi's steering and follow-up queue showed last; empty once the worker is gone. */
  queue(): QueueView;
  /**
   * Empties Pi's queue and returns the texts, fitted in JSON bytes under the frame (`truncated` when any was left
   * out). A worker that does not answer in time is `timeout`: whether it was cleared is then unknown (R105).
   */
  clearQueue(): Promise<{ steering: string[]; followUp: string[]; truncated: boolean }>;
  /**
   * Answers an open dialog. An approval returns its answer and grant,
   * for the "session" and "always" answers of Task 14b. A response the dialog does not offer is `bad_request` and
   * the dialog stays open.
   */
  answer(dialogId: string, response: DialogResponse): ApprovedAnswer | null;
  /** Hands the worker a record (a policy update); false when it was not accepted (the worker is gone or backed up). */
  send(record: DaemonToWorker): boolean;
  /**
   * Stops the worker for good (the daemon is closing, a policy update did not reach it): the exit shows `cold` with no
   * cause. Released automatically after `idleMs` of quiet (`releasing`, then `cold`): from then on `prompt`, `command`
   * and `clearQueue` are refused with `worker_failed` (empty for the queue) and nothing is sent to the worker.
   */
  stop(): Promise<void>;
  /**
   * The worker was asked to stop (a release, the daemon closing, a policy update it could not be given): it drops what
   * it is sent from then on. The one answer to "is it closing", whatever `status()` shows: an extension may start a run
   * while the worker closes.
   */
  stopping(): boolean;
  /** Resolves, never rejects, once the worker has exited and the exit has been handled (the service has forgotten the session by then). */
  exited(): Promise<void>;
}

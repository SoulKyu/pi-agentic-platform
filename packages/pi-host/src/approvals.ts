import { randomUUID } from "node:crypto";
import {
  type ApprovalAnswer,
  ApprovalRequestRecord,
  type GuardRule,
  type ToolCategory,
} from "@pap/contracts";

export interface ApprovalAsk {
  readonly category: ToolCategory;
  readonly title: string;
  readonly message: string;
  readonly tool: string;
  readonly key: string;
  readonly answers: readonly ApprovalAnswer[];
  /** Untrusted content reached the session before this call (stage 07). */
  readonly tainted?: boolean | undefined;
  /** The stage-04 rule that raised this question, if the guard did. */
  readonly guard?: GuardRule | undefined;
}
export interface ApprovalOutcome {
  readonly answer: ApprovalAnswer;
  /**
   * The question went away unanswered: Stop, a shutdown, a request that could not leave or that the schema refuses, the
   * daemon's `cancelled`, a malformed response, or the cap of pending questions. Never the person's refusal.
   */
  readonly closed: boolean;
}
export type ApprovalOutbound =
  | ({ type: "approval_request"; id: string } & Omit<ApprovalAsk, "answers"> & { answers: ApprovalAnswer[] })
  | { type: "extension_ui_closed"; id: string };

export interface Approvals {
  ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** `cancelled`: the daemon could not show the question; it closes like Stop, never as the user's refusal (M2-RT-22). */
  resolve(record: { id: string; answer: ApprovalAnswer; cancelled?: true | undefined }): void;
  cancelAll(): void;
  pendingCount(): number;
}

/**
 * The daemon keeps at most 64 dialogs per session (`MAX_DIALOGS`, dialogs.ts) and cancels the next one: asking for
 * more than that here only parks calls the daemon would refuse, so the next question is closed without leaving.
 */
export const MAX_PENDING_APPROVALS = 64;

const CLOSED: ApprovalOutcome = { answer: "deny", closed: true };

/**
 * The policy's questions. Only pap-policy holds this object: the extension API can only reach `ctx.ui`. Code running
 * inside the worker could still send the record itself (R101's residual, ADR 0008).
 */
export function createApprovals(
  send: (record: ApprovalOutbound) => boolean,
  options: { newId?: () => string } = {},
): Approvals {
  const newId = options.newId ?? randomUUID;
  const pending = new Map<
    string,
    { offered: readonly ApprovalAnswer[]; settle(outcome: ApprovalOutcome): void }
  >();
  // A channel that throws is a channel that could not carry the record.
  const trySend = (record: ApprovalOutbound): boolean => {
    try {
      return send(record);
    } catch {
      return false;
    }
  };
  return {
    ask(request, signal) {
      if (signal?.aborted || pending.size >= MAX_PENDING_APPROVALS) return Promise.resolve(CLOSED);
      const id = newId();
      const record = { type: "approval_request" as const, id, ...request, answers: [...request.answers] };
      // A question the daemon's schema would refuse is dropped there, and the call would wait for ever: closed now.
      if (pending.has(id) || !ApprovalRequestRecord.safeParse(record).success) return Promise.resolve(CLOSED);
      return new Promise((resolve) => {
        const close = () => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", close);
          trySend({ type: "extension_ui_closed", id });
          resolve(CLOSED);
        };
        pending.set(id, {
          offered: request.answers,
          settle: (outcome) => {
            if (!pending.delete(id)) return;
            signal?.removeEventListener("abort", close);
            resolve(outcome);
          },
        });
        signal?.addEventListener("abort", close, { once: true });
        if (!trySend(record)) pending.get(id)?.settle(CLOSED);
      });
    },
    resolve(record) {
      const entry = pending.get(record.id);
      if (!entry) return;
      if (record.cancelled) entry.settle(CLOSED);
      else
        entry.settle({
          answer: entry.offered.includes(record.answer) ? record.answer : "deny",
          closed: false,
        });
    },
    cancelAll() {
      for (const [id, entry] of [...pending]) {
        trySend({ type: "extension_ui_closed", id });
        entry.settle(CLOSED);
      }
    },
    pendingCount: () => pending.size,
  };
}

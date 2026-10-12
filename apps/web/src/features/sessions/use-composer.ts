import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import {
  deviceStorage,
  loadDraft,
  loadPending,
  MAX_DRAFT_CHARS,
  mergeRestored,
  saveDraft,
  savePending,
  signOutCount,
  type PendingSend,
} from "../../stores/drafts.ts";
import {
  loadBehavior,
  planSend,
  restoreCleared,
  saveBehavior,
  stopSession,
  type Behavior,
  type Cleared,
} from "./composer.vm.ts";
import { failureCode, failureText, outcomeUnknown } from "./failure.ts";

/**
 * The composer's state: the draft (saved as it changes), the way a message goes while the agent works, a send whose
 * outcome is unknown, and the error of the last action. The text lives in a ref as well, so an answer that arrives
 * later merges with what was typed meanwhile instead of replacing it.
 */
export function useComposer(sessionId: string, view: SessionView) {
  const runtime = getRuntime();
  const [storage] = useState(deviceStorage);
  const [text, setText] = useState(() => loadDraft(storage, sessionId));
  const [behavior, setBehavior] = useState(() => loadBehavior(storage));
  const [pending, setPending] = useState(() => loadPending(storage, sessionId));
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // The daemon answered `session_busy`: something structural (a tree navigation...) runs that the view does not show.
  const [refusedAsBusy, setRefusedAsBusy] = useState(false);
  // Why the last action did nothing, or what it could not do; shown politely (a live region), never as an alert.
  const [note, setNote] = useState<"pending" | "compacting" | "sending" | "truncated" | null>(null);
  // One prompt RPC at a time: the write-ahead entry always belongs to the send in flight.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const resendingRef = useRef(false);
  const mounted = useRef(true);
  const textRef = useRef(text);
  // The editor text this screen has already applied (or found at mount): a remount never replays it (M2-RT-10).
  const seenSeq = useRef(view.editorText?.seq ?? 0);

  // What is shown is what is stored and sent: the input stops at the draft cap.
  const commit = useCallback(
    (typed: string) => {
      const next = typed.slice(0, MAX_DRAFT_CHARS);
      textRef.current = next;
      setText(next);
      saveDraft(storage, sessionId, next);
    },
    [storage, sessionId],
  );
  const remember = useCallback(
    (next: PendingSend | null) => {
      setPending(next);
      savePending(storage, sessionId, next);
    },
    [storage, sessionId],
  );
  const giveBack = (cleared: Cleared) => {
    commit(restoreCleared(cleared, textRef.current));
    if (cleared.truncated) setNote("truncated");
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const instruction = view.editorText;
    if (instruction && instruction.seq > seenSeq.current) {
      seenSeq.current = instruction.seq;
      commit(instruction.text);
    }
  }, [view.editorText, commit]);

  // The message is stored before the call (write-ahead): a reload while it is in flight offers "Send again" with the
  // same command id, which the daemon answers from its receipt. A definite outcome removes it; `timeout` and
  // `connection_lost` keep it. After a sign-out nothing is written back, and an instance that has gone away
  // writes only to storage, merging with the draft that is stored now (a newer instance may own it).
  const deliver = async (params: PendingSend["params"], commandId: string) => {
    setError(null);
    const signOuts = signOutCount();
    savePending(storage, sessionId, { params, commandId });
    sendingRef.current = true;
    setSending(true);
    try {
      await runtime.rpc.call("sessions.prompt", params, { commandId });
    } catch (failure) {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
      if (signOuts !== signOutCount()) return;
      if (outcomeUnknown(failure)) {
        savePending(storage, sessionId, { params, commandId });
        if (mounted.current) setPending({ params, commandId });
        return;
      }
      remember(null);
      if (mounted.current) {
        if (failureCode(failure) === "session_busy") setRefusedAsBusy(true);
        commit(mergeRestored(params.text, textRef.current));
        setError(failureText(failure));
      } else {
        saveDraft(
          storage,
          sessionId,
          mergeRestored(params.text, loadDraft(storage, sessionId)).slice(0, MAX_DRAFT_CHARS),
        );
      }
      return;
    }
    sendingRef.current = false;
    if (mounted.current) setSending(false);
    setRefusedAsBusy(false);
    remember(null);
  };

  const compacting = view.activity.compacting;
  // Adjusting state while rendering: a "blocked" note is only true while the block lasts.
  if (
    (note === "pending" && !pending) ||
    (note === "compacting" && !compacting) ||
    (note === "sending" && !sending)
  )
    setNote(null);
  const send = (way?: Behavior) => {
    if (pending || compacting || sendingRef.current) {
      setNote(pending ? "pending" : compacting ? "compacting" : "sending");
      return;
    }
    const plan = planSend(textRef.current, way ?? behavior);
    if (!plan) return;
    if (way && way !== behavior) {
      setBehavior(way);
      saveBehavior(storage, way);
    }
    setNote(null);
    commit("");
    void deliver({ sessionId, ...plan }, runtime.rpc.newCommandId());
  };

  return {
    text,
    behavior,
    pending,
    error,
    note:
      note === "pending"
        ? t("sessions.composer.blockedPending")
        : note === "compacting"
          ? t("sessions.composer.blockedCompacting")
          : note === "sending"
            ? t("sessions.composer.blockedSending")
            : note === "truncated"
              ? t("sessions.composer.truncated")
              : null,
    resending,
    compacting,
    sending,
    running: view.status === "running",
    canStop: view.status === "running" || compacting || refusedAsBusy,
    changeText: commit,
    send,
    sendAgain: async () => {
      if (!pending || resendingRef.current || sendingRef.current) return;
      resendingRef.current = true;
      setResending(true);
      await deliver(pending.params, pending.commandId);
      resendingRef.current = false;
      if (mounted.current) setResending(false);
    },
    edit: () => {
      if (!pending) return;
      commit(mergeRestored(pending.params.text, textRef.current));
      remember(null);
    },
    stop: () => {
      setError(null);
      setNote(null);
      stopSession(runtime, sessionId, giveBack).then(
        () => setRefusedAsBusy(false),
        (failure: unknown) => setError(failureText(failure)),
      );
    },
    clearQueue: () => {
      setError(null);
      setNote(null);
      runtime.rpc.call("sessions.clearQueue", { sessionId }).then(giveBack, (failure: unknown) => {
        setError(failureText(failure));
      });
    },
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import {
  deviceStorage,
  loadDraft,
  loadPending,
  MAX_DRAFT_CHARS,
  mergeRestored,
  onPendingChange,
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

/** Text put in the composer from outside the stream ("Edit from here"); `n` rises with each one. */
export interface Injected {
  readonly n: number;
  readonly text: string;
}

/**
 * The composer's state: the draft (saved as it changes), the way a message goes while the agent works, a send whose
 * outcome is unknown, and the error of the last action. The text lives in a ref as well, so an answer that arrives
 * later merges with what was typed meanwhile instead of replacing it.
 */
export function useComposer(
  sessionId: string,
  view: SessionView,
  outside: { readonly injected: Injected | null; readonly structuralBusy: boolean } = {
    injected: null,
    structuralBusy: false,
  },
) {
  const runtime = getRuntime();
  const t = useT();
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
  const pendingRef = useRef(pending);
  // The editor text this screen has already applied (or found at mount): a remount never replays it (M2-RT-10).
  const seenSeq = useRef(view.editorText?.seq ?? 0);
  // "Edit from here" has a counter of its own, so it never moves `seenSeq`: an extension's text with a sequence this
  // screen has applied is not replayed over it, and a newer extension text still wins (M2R121).
  const seenInjected = useRef(outside.injected?.n ?? 0);

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
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A send of the screen before this one may still be in flight when this one mounts: the record is kept as unknown
  // until that send ends, and a definite end removes it here too.
  useEffect(
    () =>
      onPendingChange(sessionId, () => {
        if (sendingRef.current) return; // this screen's own send writes its record itself
        const stored = loadPending(storage, sessionId);
        if (pendingRef.current && !stored) {
          // The send ended with a refusal in an older screen, which stored the text it gives back as the draft.
          const returned = loadDraft(storage, sessionId);
          if (returned !== textRef.current) commit(returned);
        }
        setPending((shown) => (shown?.commandId === stored?.commandId ? shown : stored));
      }),
    [storage, sessionId, commit],
  );
  useEffect(() => {
    const instruction = view.editorText;
    if (instruction && instruction.seq > seenSeq.current) {
      seenSeq.current = instruction.seq;
      commit(instruction.text);
    }
  }, [view.editorText, commit]);
  // It replaces the text typed so far (the TUI does). A send of unknown outcome is untouched: it stays stored and
  // offered, "Edit" merges its text with this one, and Send waits for it as before. A send in flight gives its text
  // back by merging with what is here (`giveBack`, `deliver`).
  const injected = outside.injected;
  useEffect(() => {
    if (injected && injected.n > seenInjected.current) {
      seenInjected.current = injected.n;
      commit(injected.text);
    }
  }, [injected, commit]);

  // The message is stored before the call (write-ahead): a reload while it is in flight offers "Send again" with the
  // same command id, which the daemon answers from its receipt. A definite outcome removes it; `timeout` and
  // `connection_lost` keep it. After a sign-out nothing is written back, and an instance that has gone away
  // writes only to storage, merging with the draft that is stored now (a newer instance may own it).
  const deliver = async (params: PendingSend["params"], commandId: string) => {
    setError(null);
    const signOuts = signOutCount();
    sendingRef.current = true;
    savePending(storage, sessionId, { params, commandId });
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
      // The draft is stored first: a screen that came back follows the record's removal and reads it then.
      if (!mounted.current) {
        saveDraft(
          storage,
          sessionId,
          mergeRestored(params.text, loadDraft(storage, sessionId)).slice(0, MAX_DRAFT_CHARS),
        );
      }
      remember(null);
      if (mounted.current) {
        if (failureCode(failure) === "session_busy") setRefusedAsBusy(true);
        commit(mergeRestored(params.text, textRef.current));
        setError(failureText(failure));
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
  /** `remember: false` sends this message the given way without changing the saved choice (the one-shot chord). */
  const send = (way?: Behavior, options?: { readonly remember?: boolean }) => {
    if (pending || compacting || sendingRef.current) {
      setNote(pending ? "pending" : compacting ? "compacting" : "sending");
      return;
    }
    const plan = planSend(textRef.current, way ?? behavior);
    if (!plan) return;
    if (way && way !== behavior && options?.remember !== false) {
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
    canStop: view.status === "running" || compacting || refusedAsBusy || outside.structuralBusy,
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

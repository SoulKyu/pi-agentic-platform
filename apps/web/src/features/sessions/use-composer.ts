import { useCallback, useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import {
  deviceStorage,
  loadDraft,
  loadPending,
  mergeRestored,
  saveDraft,
  savePending,
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
  const textRef = useRef(text);
  // The editor text this screen has already applied (or found at mount): a remount never replays it (M2-RT-10).
  const seenSeq = useRef(view.editorText?.seq ?? 0);

  const commit = useCallback(
    (next: string) => {
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
  const giveBack = (cleared: Cleared) => commit(restoreCleared(cleared, textRef.current));

  useEffect(() => {
    const instruction = view.editorText;
    if (instruction && instruction.seq > seenSeq.current) {
      seenSeq.current = instruction.seq;
      commit(instruction.text);
    }
  }, [view.editorText, commit]);

  const deliver = async (params: PendingSend["params"], commandId: string, retry: boolean) => {
    setError(null);
    try {
      await runtime.rpc.call("sessions.prompt", params, { commandId });
      setRefusedAsBusy(false);
      if (retry) remember(null);
    } catch (failure) {
      if (outcomeUnknown(failure)) {
        remember({ params, commandId });
        return;
      }
      if (retry) remember(null);
      if (failureCode(failure) === "session_busy") setRefusedAsBusy(true);
      commit(mergeRestored(params.text, textRef.current));
      setError(failureText(failure));
    }
  };

  const compacting = view.activity.compacting;
  const send = (way?: Behavior) => {
    if (pending || compacting) return;
    const plan = planSend(textRef.current, way ?? behavior);
    if (!plan) return;
    if (way && way !== behavior) {
      setBehavior(way);
      saveBehavior(storage, way);
    }
    commit("");
    void deliver({ sessionId, ...plan }, runtime.rpc.newCommandId(), false);
  };

  return {
    text,
    behavior,
    pending,
    error,
    resending,
    compacting,
    running: view.status === "running",
    canStop: view.status === "running" || compacting || refusedAsBusy,
    changeText: commit,
    send,
    sendAgain: async () => {
      if (!pending || resending) return;
      setResending(true);
      await deliver(pending.params, pending.commandId, true);
      setResending(false);
    },
    edit: () => {
      if (!pending) return;
      commit(mergeRestored(pending.params.text, textRef.current));
      remember(null);
    },
    stop: () => {
      setError(null);
      stopSession(runtime, sessionId, giveBack).then(
        () => setRefusedAsBusy(false),
        (failure: unknown) => setError(failureText(failure)),
      );
    },
    clearQueue: () => {
      setError(null);
      runtime.rpc.call("sessions.clearQueue", { sessionId }).then(giveBack, (failure: unknown) => {
        setError(failureText(failure));
      });
    },
  };
}

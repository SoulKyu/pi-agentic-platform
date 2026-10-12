export const MAX_DRAFT_CHARS = 200_000;
const MAX_COMMAND_ID_CHARS = 128;
const draftKeyOf = (sessionId: string) => `pap.draft.${sessionId}`;
const pendingKeyOf = (sessionId: string) => `pap.pending.${sessionId}`;

let warned = false;
/** A draft is a convenience: storage that refuses (quota, private mode, disabled) is said once and the composer goes on. */
function warnOnce(error: unknown): void {
  if (!warned) console.warn("pap: drafts cannot be saved in this browser", error);
  warned = true;
}

/** The browser's `localStorage`, or null where merely reading the property throws (storage disabled). */
export function deviceStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

export function loadDraft(storage: Storage | null, sessionId: string): string {
  try {
    return storage?.getItem(draftKeyOf(sessionId))?.slice(0, MAX_DRAFT_CHARS) ?? "";
  } catch (error) {
    warnOnce(error);
    return "";
  }
}

export function saveDraft(storage: Storage | null, sessionId: string, text: string): void {
  try {
    if (text === "") storage?.removeItem(draftKeyOf(sessionId));
    else storage?.setItem(draftKeyOf(sessionId), text.slice(0, MAX_DRAFT_CHARS));
  } catch (error) {
    warnOnce(error);
  }
}

export function mergeRestored(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

/** A send whose outcome is unknown (R105): kept until it is sent again with the same command id, or edited. */
export interface PendingSend {
  readonly params: {
    readonly sessionId: string;
    readonly text: string;
    readonly streamingBehavior: "steer" | "followUp";
  };
  readonly commandId: string;
}

/** What storage holds is not trusted: anything of the wrong shape is dropped and removed (never thrown at the composer). */
function parsePending(raw: string, sessionId: string): PendingSend {
  const value = JSON.parse(raw) as Partial<PendingSend> | null;
  const params = value?.params;
  if (
    typeof value?.commandId === "string" &&
    value.commandId !== "" &&
    params?.sessionId === sessionId &&
    typeof params.text === "string" &&
    (params.streamingBehavior === "steer" || params.streamingBehavior === "followUp")
  ) {
    return {
      params: {
        sessionId,
        text: params.text.slice(0, MAX_DRAFT_CHARS),
        streamingBehavior: params.streamingBehavior,
      },
      commandId: value.commandId.slice(0, MAX_COMMAND_ID_CHARS),
    };
  }
  throw new Error("malformed pending message");
}

export function loadPending(storage: Storage | null, sessionId: string): PendingSend | null {
  try {
    const raw = storage?.getItem(pendingKeyOf(sessionId));
    return raw ? parsePending(raw, sessionId) : null;
  } catch (error) {
    console.warn("pap: a pending message could not be read and was dropped", error);
    // No notification: this can run while a screen renders.
    writePending(storage, sessionId, null);
    return null;
  }
}

function writePending(storage: Storage | null, sessionId: string, pending: PendingSend | null): void {
  try {
    if (pending === null) storage?.removeItem(pendingKeyOf(sessionId));
    else storage?.setItem(pendingKeyOf(sessionId), JSON.stringify(pending));
  } catch (error) {
    warnOnce(error);
  }
}

export function savePending(storage: Storage | null, sessionId: string, pending: PendingSend | null): void {
  writePending(storage, sessionId, pending);
  for (const listener of pendingListeners.get(sessionId) ?? []) listener();
}

const pendingListeners = new Map<string, Set<() => void>>();
/**
 * Calls `listener` after every write of this session's pending record in this page. A screen that came back while a
 * send of the screen before it was in flight learns that way how the send ended (M2 #44).
 */
export function onPendingChange(sessionId: string, listener: () => void): () => void {
  const listeners = pendingListeners.get(sessionId) ?? new Set();
  pendingListeners.set(sessionId, listeners.add(listener));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingListeners.delete(sessionId);
  };
}

let signOuts = 0;
/** Counts the sign-outs of this page: an answer that arrives after one must not write what the sign-out removed. */
export const signOutCount = (): number => signOuts;

/** Sign-out (owner R2-4): no draft or pending message stays on a shared device. The streaming preference stays. */
export function clearSessionDrafts(storage: Storage | null): void {
  signOuts++;
  try {
    const keys = Array.from({ length: storage?.length ?? 0 }, (_, index) => storage?.key(index) ?? "");
    for (const key of keys) {
      if (key.startsWith("pap.draft.") || key.startsWith("pap.pending.")) storage?.removeItem(key);
    }
  } catch (error) {
    console.warn("pap: drafts could not be cleared", error);
  }
}

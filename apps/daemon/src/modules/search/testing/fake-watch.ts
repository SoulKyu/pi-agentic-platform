/** The shape of `WatchFactory`, spelled here because a test helper imports no module internals. */
type FakeFactory = (
  dir: string,
  onEvent: (name: string | null) => void,
  onError: (code: string) => void,
) => (() => void) | null;

export interface FakeWatch {
  readonly factory: FakeFactory;
  /** Every folder ever watched, in order. */
  readonly watched: string[];
  /** Folders whose watcher is open now. */
  open(): string[];
  /** Folders whose watcher was closed (by the engine or by `fail`). */
  readonly closed: string[];
  /** Folders the factory refuses (answers null and reports `EMFILE`). */
  readonly refuse: Set<string>;
  emit(dir: string, name: string | null): void;
  fail(dir: string, code: string): void;
}

/** A `WatchFactory` the test drives by hand. */
export function fakeWatch(): FakeWatch {
  const live = new Map<string, { onEvent: (name: string | null) => void; onError: (code: string) => void }>();
  const watched: string[] = [];
  const closed: string[] = [];
  const refuse = new Set<string>();
  return {
    watched,
    closed,
    refuse,
    open: () => [...live.keys()],
    factory: (dir, onEvent, onError) => {
      if (refuse.has(dir)) {
        onError("EMFILE");
        return null;
      }
      watched.push(dir);
      live.set(dir, { onEvent, onError });
      return () => {
        if (live.delete(dir)) closed.push(dir);
      };
    },
    emit: (dir, name) => live.get(dir)?.onEvent(name),
    fail: (dir, code) => {
      const entry = live.get(dir);
      if (!entry) return;
      live.delete(dir);
      closed.push(dir);
      entry.onError(code);
    },
  };
}

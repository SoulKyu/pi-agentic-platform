import type { TerminalScreen } from "@pap/ui/terminal";
import { useEffect, useRef, useState } from "react";
import { getRuntime, windowTimers } from "../../runtime/index.ts";
import type { Timers } from "../../runtime/connection.ts";
import { getTerminalChannel } from "../../runtime/terminal-channel.ts";
import type { TerminalChannel, TerminalHandle, TerminalSink } from "../../runtime/terminal-types.ts";
import { feedTerminals } from "../../stores/terminal-feed.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import {
  bytesOfBinary,
  INITIAL_VIEW,
  MAX_BUSY_ATTEMPTS,
  needsConfirmation,
  RESIZE_MS,
  retryDelayMs,
  runningCount,
  SLOW_MS,
  type TerminalPaneView,
} from "./terminal.vm.ts";

const encoder = new TextEncoder();

export interface TerminalControllerDeps {
  readonly id: string;
  readonly channel: TerminalChannel;
  readonly timers: Timers;
  /** Calls the listener with the number of running terminals whenever the list changes; returns the stop. */
  watchRunning(listener: (running: number) => void): () => void;
  /** Closes the terminal on the server and the pane that shows it. */
  closeTerminal(): Promise<void>;
  onChange(view: TerminalPaneView): void;
}

export interface TerminalController {
  view(): TerminalPaneView;
  setScreen(screen: TerminalScreen | null): void;
  input(data: string): void;
  binary(data: string): void;
  resize(cols: number, rows: number): void;
  requestClose(): void;
  cancelClose(): void;
  confirmClose(): void;
  /** "Try again" after the automatic retries ran out. */
  retry(): void;
  dispose(): void;
}

/** The logic of one terminal pane, apart from React: the channel sink, replay protection, size, close and busy retry. */
export function createTerminalController(deps: TerminalControllerDeps): TerminalController {
  const { id, channel, timers } = deps;
  let view = INITIAL_VIEW;
  let screen: TerminalScreen | null = null;
  let handle: TerminalHandle | null = null;
  let disposed = false;
  // Until the bytes up to this offset are written, what xterm types is its answer to replayed queries (M8R81).
  let replayEnd: number | null = null;
  let slowTimer: number | null = null;
  let resizeTimer: number | null = null;
  let pendingSize: { cols: number; rows: number } | null = null;
  let retryTimer: number | null = null;
  let busyAttempts = 0;
  let lastRunning: number | null = null;
  let closing = false;

  const set = (next: Partial<TerminalPaneView>): void => {
    view = { ...view, ...next };
    deps.onChange(view);
  };
  const clearTimer = (timer: number | null): null => {
    if (timer !== null) timers.clear(timer);
    return null;
  };

  const enter = (phase: TerminalPaneView["phase"]): void => {
    slowTimer = clearTimer(slowTimer);
    const waiting = phase === "attaching" || phase === "offline" || phase === "busy";
    set({ phase, slow: false });
    if (waiting) {
      slowTimer = timers.set(() => {
        slowTimer = null;
        set({ slow: true });
      }, SLOW_MS);
    }
  };

  const sink: TerminalSink = {
    attached(info) {
      replayEnd = info.start < info.end ? info.end : null;
      busyAttempts = 0;
      retryTimer = clearTimer(retryTimer);
      set({ busyExhausted: false });
      if (info.status === "exited") {
        const known = useTerminalStore.getState().view.terminals.get(id);
        set({ exit: { code: known?.exitCode ?? null, signal: known?.signal ?? null } });
        enter("exited");
      }
    },
    reset() {
      screen?.reset();
    },
    output(bytes, end) {
      const target = screen;
      if (!target) {
        replayEnd = null; // nothing to answer for: do not keep the input dropped
        return Promise.resolve();
      }
      return target.write(bytes).then(
        () => {
          if (replayEnd !== null && end >= replayEnd) replayEnd = null;
        },
        (failure: unknown) => {
          replayEnd = null; // the channel counts a failed write as written; so does the guard
          throw failure;
        },
      );
    },
    exit(code, signal) {
      replayEnd = null;
      set({ exit: { code, signal } });
      enter("exited");
    },
    state(state) {
      if (state === "gone") {
        enter("gone");
      } else if (view.phase === "exited") {
        return; // the process ended: reconnecting does not bring it back, the output stays on screen
      } else {
        enter(state);
      }
    },
  };

  const open = (): void => {
    handle = channel.open(id, sink);
  };
  const reopen = (): void => {
    handle?.close();
    handle = null;
    if (!disposed) open();
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null) return;
    if (busyAttempts >= MAX_BUSY_ATTEMPTS) {
      set({ busyExhausted: true });
      return;
    }
    retryTimer = timers.set(() => {
      retryTimer = null;
      if (disposed || view.phase !== "busy") return;
      busyAttempts++;
      reopen();
    }, retryDelayMs(busyAttempts));
  };

  // Only a slot that frees is worth another try: a count that stays or grows says nothing new.
  const unwatch = deps.watchRunning((running) => {
    const freed = lastRunning !== null && running < lastRunning;
    lastRunning = running;
    if (freed && view.phase === "busy") scheduleRetry();
  });

  const send = (bytes: Uint8Array): void => {
    if (replayEnd !== null || view.phase !== "live") return;
    handle?.input(bytes);
  };

  const flushSize = (): void => {
    resizeTimer = null;
    if (pendingSize) handle?.resize(pendingSize.cols, pendingSize.rows);
    pendingSize = null;
  };

  const confirmClose = (): void => {
    if (closing) return;
    closing = true;
    set({ confirmingClose: false });
    deps.closeTerminal().then(
      () => {
        closing = false;
      },
      () => {
        closing = false;
        set({ closeFailed: true });
      },
    );
  };

  open();

  return {
    view: () => view,
    setScreen(next) {
      screen = next;
    },
    input: (data) => send(encoder.encode(data)),
    binary: (data) => send(bytesOfBinary(data)),
    resize(cols, rows) {
      pendingSize = { cols, rows };
      resizeTimer ??= timers.set(flushSize, RESIZE_MS);
    },
    requestClose() {
      if (needsConfirmation(view.phase)) set({ confirmingClose: true, closeFailed: false });
      else confirmClose();
    },
    cancelClose() {
      set({ confirmingClose: false });
    },
    confirmClose,
    retry() {
      busyAttempts = 0;
      set({ busyExhausted: false });
      reopen();
    },
    dispose() {
      disposed = true;
      unwatch();
      slowTimer = clearTimer(slowTimer);
      resizeTimer = clearTimer(resizeTimer);
      retryTimer = clearTimer(retryTimer);
      handle?.close();
      handle = null;
      screen = null;
    },
  };
}

/** The terminal store's number of running terminals, as a stream for the busy retry. */
export function watchRunningTerminals(listener: (running: number) => void): () => void {
  listener(runningCount(useTerminalStore.getState().view.list));
  return useTerminalStore.subscribe((state, previous) => {
    if (state.view.list !== previous.view.list) listener(runningCount(state.view.list));
  });
}

export interface UseTerminal {
  readonly view: TerminalPaneView;
  readonly surface: {
    onScreen(screen: TerminalScreen | null): void;
    onData(data: string): void;
    onBinary(data: string): void;
    onResize(cols: number, rows: number): void;
  };
  readonly controller: () => TerminalController | null;
}

/** One pane's terminal: the controller over the page's channel, and the callbacks the surface calls. */
export function useTerminal(
  id: string,
  closeTerminal: () => Promise<void>,
  options: { readonly channel?: TerminalChannel; readonly timers?: Timers } = {},
): UseTerminal {
  const [view, setView] = useState(INITIAL_VIEW);
  const controllerRef = useRef<TerminalController | null>(null);
  // The surface reports its first size and its screen before this effect has made the controller.
  const screenRef = useRef<TerminalScreen | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const closeRef = useRef(closeTerminal);
  useEffect(() => {
    closeRef.current = closeTerminal;
  });
  const { channel, timers } = options;

  useEffect(() => {
    // Feeds the store while the pane is open, so the busy retry and the exit code have a list even on a direct URL.
    const stopFeed = feedTerminals(getRuntime().subscriptions);
    const controller = createTerminalController({
      id,
      channel: channel ?? getTerminalChannel(),
      timers: timers ?? windowTimers,
      watchRunning: watchRunningTerminals,
      closeTerminal: () => closeRef.current(),
      onChange: setView,
    });
    controllerRef.current = controller;
    controller.setScreen(screenRef.current);
    if (sizeRef.current) controller.resize(sizeRef.current.cols, sizeRef.current.rows);
    return () => {
      controllerRef.current = null;
      controller.dispose();
      stopFeed();
    };
  }, [id, channel, timers]);

  return {
    view,
    controller: () => controllerRef.current,
    surface: {
      onScreen: (screen) => {
        screenRef.current = screen;
        controllerRef.current?.setScreen(screen);
      },
      onData: (data) => controllerRef.current?.input(data),
      onBinary: (data) => controllerRef.current?.binary(data),
      onResize: (cols, rows) => {
        sizeRef.current = { cols, rows };
        controllerRef.current?.resize(cols, rows);
      },
    },
  };
}

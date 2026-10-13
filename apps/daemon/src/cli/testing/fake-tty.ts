import { EventEmitter } from "node:events";
import type { CliIo } from "../open-home.ts";

/** A terminal that records raw-mode changes; `press` emits what the user typed. */
export function fakeTty() {
  const modes: boolean[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      modes.push(mode);
    },
    resume() {
      return stream;
    },
    pause() {
      return stream;
    },
  });
  return {
    stdin: stream as unknown as CliIo["stdin"],
    modes,
    press: (text: string) => stream.emit("data", Buffer.from(text)),
    fail: (error: Error) => stream.emit("error", error),
    listeners: () => stream.listenerCount("data") + stream.listenerCount("error"),
  };
}

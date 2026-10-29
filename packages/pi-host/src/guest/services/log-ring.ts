import { StringDecoder } from "node:string_decoder";
import { SERVICE_LIMITS } from "@pap/contracts/pi-host";

export interface LogRing {
  /** Adds output; `source` keeps stdout and stderr partial lines apart while their lines interleave in arrival order. */
  write(chunk: Buffer | string, source?: 1 | 2): void;
  /** Turns the partial lines into lines (the process ended). */
  flush(): void;
  lines(): string[];
}

const { logLines, lineChars } = SERVICE_LIMITS;

/** A cut never lands between the two halves of a surrogate pair. */
const cutAt = (text: string): number => {
  const high = text.charCodeAt(lineChars - 1);
  return high >= 0xd800 && high <= 0xdbff ? lineChars - 1 : lineChars;
};

/**
 * What a service printed, last 200 lines of at most 512 characters (UX2-R21). A longer line is flushed at 512 and goes on
 * in the next one. Bounded in lines, in line length and in the two partial lines it holds.
 */
export function createLogRing(): LogRing {
  const kept: string[] = [];
  const partial = new Map<number, string>();
  const decoders = new Map<number, StringDecoder>();
  const push = (line: string): void => {
    kept.push(line.replace(/\r$/, ""));
    if (kept.length > logLines) kept.shift();
  };
  return {
    write(chunk, source = 1) {
      let decoder = decoders.get(source);
      if (decoder === undefined) decoders.set(source, (decoder = new StringDecoder("utf8")));
      let pending = (partial.get(source) ?? "") + (typeof chunk === "string" ? chunk : decoder.write(chunk));
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline >= 0 && newline <= lineChars) {
          push(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        } else if (pending.length > lineChars) {
          const cut = cutAt(pending);
          push(pending.slice(0, cut));
          pending = pending.slice(cut);
        } else break;
      }
      partial.set(source, pending);
    },
    flush() {
      for (const [source, text] of partial) {
        const tail = text + (decoders.get(source)?.end() ?? "");
        if (tail !== "") push(tail);
        partial.set(source, "");
      }
    },
    lines: () => [...kept],
  };
}

import { logLineOf } from "./bounded.ts";

/** One prompt record on its way to Pi (M8R43b, RT-07). */
export interface QueuedPrompt {
  /** Reads what the prompt carries (its images). Never throws; absent when there is nothing to read. */
  readonly prepare?: () => Promise<void>;
  /**
   * Hands the prompt to Pi: called once, in arrival order, never after `drop`. A promise holds the prompts behind it
   * until it settles: Pi's own steps before a prompt with images (it normalises them again) are longer than a text
   * prompt's, so a text prompt handed over at once would be answered first (M8R107). It settles when Pi has answered.
   */
  start(): void | Promise<void>;
  /** Called instead of `start` when an abort arrived first: answers `pap:aborted`. */
  drop(): void;
}

export interface PromptQueue {
  push(prompt: QueuedPrompt): void;
  /** An abort: every prompt not yet handed to Pi is dropped, the one preparing included. */
  dropWaiting(): void;
}

/**
 * Prompts reach Pi in arrival order although an image prompt prepares asynchronously: each waits for the ones before
 * it to be prepared and, when a start returns a promise (an image prompt), until Pi has answered it. Stop ends every
 * wait. A text prompt with nothing ahead starts at once, as before M8.
 */
export function createPromptQueue(log: (line: string) => void): PromptQueue {
  const waiting: QueuedPrompt[] = [];
  let draining = false;
  // Each Stop starts a new generation: a drain of an earlier one leaves the queue alone (it may still be waiting).
  let generation = 0;

  const logged = (what: string) => (error: unknown) =>
    log(`pi-host: prompt ${what} failed: ${logLineOf(error)}\n`);
  const guarded = (what: string, step: () => void | Promise<void>): Promise<void> | undefined => {
    try {
      const result = step();
      return result instanceof Promise ? result.catch(logged(what)) : undefined;
    } catch (error) {
      logged(what)(error);
      return undefined;
    }
  };

  async function drain(): Promise<void> {
    draining = true;
    const mine = generation;
    while (waiting.length > 0) {
      const head = waiting[0] as QueuedPrompt;
      if (head.prepare)
        await head.prepare().catch((error: unknown) => {
          log(`pi-host: prompt prepare failed: ${logLineOf(error)}\n`);
        });
      if (mine !== generation) return; // a Stop dropped it while it prepared
      waiting.shift();
      const held = guarded("start", () => head.start());
      // A Stop abandons this wait (`generation`): Pi may never answer (an extension command that does not end).
      if (held) await held;
      if (mine !== generation) return;
    }
    draining = false;
  }

  return {
    push(prompt) {
      if (!draining && waiting.length === 0 && prompt.prepare === undefined)
        return void guarded("start", () => prompt.start());
      waiting.push(prompt);
      if (!draining) void drain();
    },
    dropWaiting() {
      generation++;
      draining = false;
      for (const prompt of waiting.splice(0)) void guarded("drop", () => prompt.drop());
    },
  };
}

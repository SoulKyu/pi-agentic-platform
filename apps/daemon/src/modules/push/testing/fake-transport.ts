import type { PushTransport, SendOutcome, SubscriptionTarget } from "../index.ts";

type SendOpts = Parameters<PushTransport["send"]>[2];

export interface FakeTransport extends PushTransport {
  /** Every call, in order, recorded when `send` is called (before a hold). The target is the caller's own object. */
  readonly sent: Array<{ target: SubscriptionTarget; plaintext: Uint8Array; opts: SendOpts }>;
  /** The outcome of a later send; queued outcomes are used in order, then `ok`. */
  next(outcome: SendOutcome): void;
  setStatus(on: boolean): void;
  /** The next send waits until `release()`, or answers `retry` if its signal aborts first. */
  hold(): { release(): void };
}

/** Chain B's only transport: records what it is given and answers as the test says. Nothing is encrypted. */
export function createFakeTransport(): FakeTransport {
  const sent: FakeTransport["sent"] = [];
  const queue: SendOutcome[] = [];
  const holds: Array<Promise<void>> = [];
  let on = true;
  return {
    sent,
    next: (outcome) => void queue.push(outcome),
    setStatus: (value) => void (on = value),
    hold() {
      let release!: () => void;
      holds.push(new Promise<void>((resolve) => (release = resolve)));
      return { release };
    },
    status: () => ({ on, reason: null, publicKey: on ? "fake-public-key" : null }),
    async send(target, plaintext, opts, signal) {
      sent.push({ target, plaintext, opts });
      const held = holds.shift();
      if (held) {
        const aborted = new Promise<"aborted">((resolve) =>
          signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
        );
        if ((await Promise.race([held.then(() => "released" as const), aborted])) === "aborted")
          return { kind: "retry" };
      }
      return queue.shift() ?? { kind: "ok" };
    },
  };
}

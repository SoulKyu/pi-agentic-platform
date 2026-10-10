import { randomBytes } from "node:crypto";
import type { Cursor, EventFrame, StreamName } from "@pap/contracts";
import { createSystemClock, type Clock, type TimerHandle } from "../clock.ts";

export const MAX_REPLAY_EVENTS = 128;
export const MAX_REPLAY_BYTES = 1024 * 1024;
/** How long a channel without subscribers keeps its replay ring: the client's cache window (spec C 4.3). */
export const IDLE_RING_MS = 5 * 60 * 1000;

export type SnapshotProvider = (key: string) => unknown;

interface Entry {
  readonly seq: number;
  readonly event: unknown;
  readonly bytes: number;
}

interface Subscriber {
  readonly sub: string;
  send(frame: EventFrame): void;
  /** Live frames wait here between prepare and commit, so none is lost and none overtakes the replay. */
  queued: EventFrame[] | null;
}

// `seq` outlives the ring: after an idle eviction a stale cursor must still compare against the real
// counter, so that it falls through to a snapshot instead of matching a restarted number.
interface Channel {
  seq: number;
  ring: Entry[];
  ringBytes: number;
  idleTimer: TimerHandle | null;
  readonly subscribers: Map<string, Subscriber>;
}

export interface OpenInput {
  readonly connectionId: string;
  readonly sub: string;
  readonly stream: StreamName;
  readonly key: string;
  readonly after: Cursor | undefined;
  send(frame: EventFrame): void;
}

export interface PreparedOpen {
  /** Sends the replay or snapshot frames, then whatever was published since `prepare`, then goes live. */
  commit(): void;
}

export interface StreamHub {
  readonly epoch: string;
  registerSnapshot(stream: StreamName, provider: SnapshotProvider): void;
  /** Throws before touching any state when the event cannot be serialised. */
  publish(stream: StreamName, key: string, event: unknown): void;
  /**
   * Builds the replay or snapshot and registers the subscriber, holding live frames back until
   * `commit`. Throws with nothing registered when the snapshot cannot be built; the caller undoes a
   * prepared subscription it will not commit with `close`.
   */
  prepare(input: OpenInput): PreparedOpen;
  /** `prepare` then `commit`. */
  open(input: OpenInput): void;
  close(connectionId: string, sub?: string): void;
  stats(): { channels: number; subscriptions: number };
}

function canReplay(
  seq: number,
  ring: readonly Entry[],
  after: Cursor | undefined,
  epoch: string,
): after is Cursor {
  if (!after || after.epoch !== epoch || after.seq > seq) return false;
  if (after.seq === seq) return true;
  const first = ring[0];
  return first !== undefined && first.seq <= after.seq + 1;
}

export function createStreamHub(
  epoch: string = randomBytes(8).toString("hex"),
  clock: Clock = createSystemClock(),
): StreamHub {
  const channels = new Map<string, Channel>();
  const providers = new Map<StreamName, SnapshotProvider>();
  const subscriptions = new Map<string, { readonly channel: Channel; readonly subscriber: Subscriber }>();

  const armIdle = (channel: Channel): void => {
    if (channel.idleTimer || channel.subscribers.size > 0 || channel.ring.length === 0) return;
    channel.idleTimer = clock.setTimeout(() => {
      channel.idleTimer = null;
      channel.ring = [];
      channel.ringBytes = 0;
    }, IDLE_RING_MS);
  };
  const disarmIdle = (channel: Channel): void => {
    if (channel.idleTimer) clock.clearTimeout(channel.idleTimer);
    channel.idleTimer = null;
  };
  const newChannel = (): Channel => ({
    seq: 0,
    ring: [],
    ringBytes: 0,
    idleTimer: null,
    subscribers: new Map(),
  });
  const deliver = (subscriber: Subscriber, frame: EventFrame): void => {
    if (subscriber.queued) subscriber.queued.push(frame);
    else subscriber.send(frame);
  };

  function prepare(input: OpenInput): PreparedOpen {
    const id = `${input.stream}:${input.key}`;
    const existing = channels.get(id);
    const seq = existing?.seq ?? 0;
    const ring = existing?.ring ?? [];
    let frames: EventFrame[];
    if (canReplay(seq, ring, input.after, epoch)) {
      const after = input.after.seq;
      frames = ring
        .filter((entry) => entry.seq > after)
        .map((entry) => ({ sub: input.sub, epoch, seq: entry.seq, event: entry.event }));
    } else {
      // Looked up and run before any channel exists: a failure must not leave one behind.
      const provider = providers.get(input.stream);
      if (!provider) throw new Error(`no snapshot provider for stream ${input.stream}`);
      frames = [{ sub: input.sub, epoch, seq, event: provider(input.key) }];
    }
    let channel = existing;
    if (!channel) {
      channel = newChannel();
      channels.set(id, channel);
    }
    disarmIdle(channel);
    const subKey = `${input.connectionId}:${input.sub}`;
    const subscriber: Subscriber = { sub: input.sub, send: input.send, queued: [] };
    channel.subscribers.set(subKey, subscriber);
    subscriptions.set(subKey, { channel, subscriber });
    return {
      commit() {
        const queued = subscriber.queued;
        if (!queued || subscriptions.get(subKey)?.subscriber !== subscriber) return;
        subscriber.queued = null;
        for (const frame of [...frames, ...queued]) subscriber.send(frame);
      },
    };
  }

  return {
    epoch,
    registerSnapshot(stream, provider) {
      providers.set(stream, provider);
    },
    publish(stream, key, event) {
      const text = JSON.stringify(event) as string | undefined;
      if (text === undefined) throw new TypeError("stream event is not JSON-serialisable");
      const bytes = Buffer.byteLength(text);
      const id = `${stream}:${key}`;
      let channel = channels.get(id);
      if (!channel) {
        channel = newChannel();
        channels.set(id, channel);
      }
      const seq = ++channel.seq;
      channel.ring.push({ seq, event, bytes });
      channel.ringBytes += bytes;
      while (channel.ring.length > MAX_REPLAY_EVENTS || channel.ringBytes > MAX_REPLAY_BYTES) {
        const dropped = channel.ring.shift();
        if (!dropped) break;
        channel.ringBytes -= dropped.bytes;
      }
      armIdle(channel);
      for (const subscriber of channel.subscribers.values()) {
        deliver(subscriber, { sub: subscriber.sub, epoch, seq, event });
      }
    },
    prepare,
    open(input) {
      prepare(input).commit();
    },
    close(connectionId, sub) {
      for (const [subKey, { channel }] of [...subscriptions]) {
        if (!subKey.startsWith(`${connectionId}:`)) continue;
        if (sub !== undefined && subKey !== `${connectionId}:${sub}`) continue;
        channel.subscribers.delete(subKey);
        subscriptions.delete(subKey);
        armIdle(channel);
      }
    },
    stats: () => ({ channels: channels.size, subscriptions: subscriptions.size }),
  };
}

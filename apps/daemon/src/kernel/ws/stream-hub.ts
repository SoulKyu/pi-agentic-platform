import { randomBytes } from "node:crypto";
import type { Cursor, EventFrame, StreamName } from "@pap/contracts";

export const MAX_REPLAY_EVENTS = 128;
export const MAX_REPLAY_BYTES = 1024 * 1024;

export type SnapshotProvider = (key: string) => unknown;

interface Entry {
  readonly seq: number;
  readonly event: unknown;
  readonly bytes: number;
}

interface Channel {
  seq: number;
  ring: Entry[];
  ringBytes: number;
  readonly subscribers: Map<string, { readonly sub: string; send(frame: EventFrame): void }>;
}

export interface OpenInput {
  readonly connectionId: string;
  readonly sub: string;
  readonly stream: StreamName;
  readonly key: string;
  readonly after: Cursor | undefined;
  send(frame: EventFrame): void;
}

export interface StreamHub {
  readonly epoch: string;
  registerSnapshot(stream: StreamName, provider: SnapshotProvider): void;
  publish(stream: StreamName, key: string, event: unknown): void;
  open(input: OpenInput): void;
  close(connectionId: string, sub?: string): void;
}

function canReplay(channel: Channel, after: Cursor | undefined, epoch: string): after is Cursor {
  if (!after || after.epoch !== epoch || after.seq > channel.seq) return false;
  if (after.seq === channel.seq) return true;
  const first = channel.ring[0];
  return first !== undefined && first.seq <= after.seq + 1;
}

export function createStreamHub(epoch: string = randomBytes(8).toString("hex")): StreamHub {
  const channels = new Map<string, Channel>();
  const providers = new Map<StreamName, SnapshotProvider>();
  const subscriptions = new Map<string, string>();
  const channelOf = (stream: StreamName, key: string): [string, Channel] => {
    const id = `${stream}:${key}`;
    let channel = channels.get(id);
    if (!channel) {
      channel = { seq: 0, ring: [], ringBytes: 0, subscribers: new Map() };
      channels.set(id, channel);
    }
    return [id, channel];
  };
  return {
    epoch,
    registerSnapshot(stream, provider) {
      providers.set(stream, provider);
    },
    publish(stream, key, event) {
      const [, channel] = channelOf(stream, key);
      const seq = ++channel.seq;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      channel.ring.push({ seq, event, bytes });
      channel.ringBytes += bytes;
      while (channel.ring.length > MAX_REPLAY_EVENTS || channel.ringBytes > MAX_REPLAY_BYTES) {
        const dropped = channel.ring.shift();
        if (!dropped) break;
        channel.ringBytes -= dropped.bytes;
      }
      for (const subscriber of channel.subscribers.values()) {
        subscriber.send({ sub: subscriber.sub, epoch, seq, event });
      }
    },
    open(input) {
      const [id, channel] = channelOf(input.stream, input.key);
      if (canReplay(channel, input.after, epoch)) {
        const after = input.after.seq;
        for (const entry of channel.ring) {
          if (entry.seq > after) input.send({ sub: input.sub, epoch, seq: entry.seq, event: entry.event });
        }
      } else {
        const provider = providers.get(input.stream);
        if (!provider) throw new Error(`no snapshot provider for stream ${input.stream}`);
        input.send({ sub: input.sub, epoch, seq: channel.seq, event: provider(input.key) });
      }
      const subKey = `${input.connectionId}:${input.sub}`;
      channel.subscribers.set(subKey, { sub: input.sub, send: input.send });
      subscriptions.set(subKey, id);
    },
    close(connectionId, sub) {
      for (const [subKey, channelId] of [...subscriptions]) {
        if (!subKey.startsWith(`${connectionId}:`)) continue;
        if (sub !== undefined && subKey !== `${connectionId}:${sub}`) continue;
        channels.get(channelId)?.subscribers.delete(subKey);
        subscriptions.delete(subKey);
      }
    },
  };
}

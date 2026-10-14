import { LOGIN_SNAPSHOT_EVENTS, type LoginEvent, LoginStreamEvent } from "@pap/contracts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";

/** Flows whose events the publisher keeps for a late subscriber's snapshot; the oldest is dropped past this. */
export const LOGIN_PUBLISHER_FLOWS = 32;

export interface LoginPublisher {
  /** Throws, publishing nothing, when `event` is not a `LoginEvent`: the contract is the last gate before a client. */
  publish(flowId: string, event: LoginEvent): void;
  snapshot(flowId: string): Extract<LoginStreamEvent, { kind: "snapshot" }>;
  forget(flowId: string): void;
}

/**
 * The `login` stream (M7 Task 11): each event goes to the hub under the flow id, and the last 64 of a flow are kept for the
 * snapshot a subscriber starts from. Whoever may subscribe to a flow is decided before the hub is asked (the service).
 */
export function createLoginPublisher(hub: Pick<StreamHub, "publish" | "registerSnapshot">): LoginPublisher {
  const history = new Map<string, LoginEvent[]>();
  const publisher: LoginPublisher = {
    publish(flowId, event) {
      const checked = LoginStreamEvent.parse(event) as LoginEvent;
      const events = history.get(flowId) ?? [];
      events.push(checked);
      if (events.length > LOGIN_SNAPSHOT_EVENTS) events.shift();
      history.delete(flowId);
      history.set(flowId, events);
      if (history.size > LOGIN_PUBLISHER_FLOWS) history.delete(history.keys().next().value as string);
      hub.publish("login", flowId, checked);
    },
    snapshot: (flowId) => ({ kind: "snapshot", events: [...(history.get(flowId) ?? [])] }),
    forget: (flowId) => void history.delete(flowId),
  };
  hub.registerSnapshot("login", (key) => publisher.snapshot(key));
  return publisher;
}

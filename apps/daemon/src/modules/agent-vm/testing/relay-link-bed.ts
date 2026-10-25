import { EventEmitter } from "node:events";
import type { BoxRef } from "@pap/contracts";
import { vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { createRelayLink, type PolicyView, type RelayChild } from "../index.ts";

export const KEY = "ab".repeat(32);
export const TOKEN = "sk-ant-oat01-OWNER-TOKEN-0123456789";
export const grant = (n: number, agent: string | BoxRef = "scout-0001") => ({
  launchId: String(n).repeat(32).slice(0, 32),
  box: typeof agent === "string" ? ({ kind: "agent", id: agent } as const) : agent,
  relayKey: String(n)
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a"),
  address: "10.213.0.2",
});
export const POLICY: PolicyView = {
  models: [{ provider: "acme", id: "m-1" }],
  claude: false,
  claudeToken: null,
  blocked: null,
};

export class FakeChild extends EventEmitter implements RelayChild {
  readonly sent: unknown[] = [];
  killed = false;
  pid: number | undefined = 4242;
  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  ready(): void {
    this.emit("message", { type: "relay_ready", port: 7842 });
  }
  die(): void {
    this.emit("exit", 1, null);
  }
  types(): string[] {
    return this.sent.map((message) => (message as { type: string }).type);
  }
}

export function bed(
  over: {
    policyOf?: (box: BoxRef) => Promise<PolicyView>;
    token?: string | null;
    bridgeReady?: () => Promise<void>;
    turns?: (box: BoxRef) => number;
    windowEnded?: () => void;
    listenerFault?: (child: RelayChild) => string | null;
  } = {},
) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const children: FakeChild[] = [];
  const forks = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const link = createRelayLink({
    fork: forks,
    clock,
    logger,
    policyOf: over.policyOf ?? (async () => ({ ...POLICY, claudeToken: over.token ?? null })),
    ...(over.bridgeReady ? { bridgeReady: over.bridgeReady } : {}),
    ...(over.turns ? { reportedTurns: over.turns } : {}),
    ...(over.listenerFault ? { listenerFault: over.listenerFault } : {}),
    ...(over.windowEnded ? { windowEnded: over.windowEnded } : {}),
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    clock,
    lines,
    children,
    forks,
    link,
    settle,
    last: () => children[children.length - 1] as FakeChild,
  };
}

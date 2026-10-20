import { type AddressInfo, createServer, type Server } from "node:net";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  AGENT_VM_PROTOCOL,
  createFrameDecoder,
  encodeSocketFrame,
  GATEWAY_LIMITS,
  GATEWAY_PING_MISSES,
  GATEWAY_PING_MS,
  GUEST_BOOT_TIMEOUT_MS,
  HELLO_MAX_BYTES,
  HELLO_TIMEOUT_MS,
  Hello,
  PapError,
  TransportPing,
  TransportPong,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createGatewayLimits } from "./gateway-limits.ts";
import {
  createGuestLink,
  type GuestLink,
  type GuestLinkInternals,
  type WorkerConnection,
} from "./guest-link.ts";
import type { LaunchTokens } from "./tokens.ts";
import type { Wire } from "./vm-worker.ts";

export interface Gateway {
  /** Listens on `host:port` (the bridge address under Kata, 127.0.0.1:0 under the process backend). */
  listen(host: string, port: number): Promise<{ port: number }>;
  /** Resolves when the guest of this launch has said hello; rejects `timeout` after GUEST_BOOT_TIMEOUT_MS (RT-35). */
  awaitGuest(launchId: string): Promise<GuestLink>;
  close(): Promise<void>;
}

/** The part of a `net.Socket` the gateway uses: a unit test drives it with a fake. */
export interface GatewaySocket {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  write(chunk: Buffer): boolean;
  destroy(): unknown;
  pause(): unknown;
  resume(): unknown;
  readonly writableLength: number;
  readonly remoteAddress: string | undefined;
}

export interface GatewayDeps {
  tokens: LaunchTokens;
  clock: Clock;
  logger: Logger;
  /** The image tag a launch was started with (the composition binds the runtime's `launchId -> image` map). */
  imageOf(launchId: string): string | null;
}

/** S2 m2: a refusal reason quiet for this long starts its log count again. */
export const REFUSAL_QUIET_MS = 3_600_000;

type Refusal =
  "bad_hello" | "too_large" | "timeout" | "token" | "protocol" | "image" | "slot" | "duplicate" | "busy";

interface Waiter {
  readonly resolve: (link: GuestLink) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | undefined;
}

const isHelloWithOtherProtocol = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const protocol = (value as { protocol?: unknown }).protocol;
  return (
    typeof protocol === "number" &&
    protocol !== AGENT_VM_PROTOCOL &&
    Hello.safeParse({ ...value, protocol: AGENT_VM_PROTOCOL }).success
  );
};

/** The gateway without its listener: `accept` takes a connection, whoever made it. */
export function createGatewayCore(deps: GatewayDeps): Gateway & { accept(socket: GatewaySocket): void } {
  const { tokens, clock, logger, imageOf } = deps;
  const limits = createGatewayLimits(clock);
  /** Guests whose connection is open, by launch. */
  const guests = new Map<string, GuestLinkInternals>();
  /** A launch has one guest in its lifetime: a hello after it closed is a replay. */
  const everSeen = new Set<string>();
  const waiters = new Map<string, Set<Waiter>>();
  const open = new Set<() => void>();
  let stopped = false;

  /**
   * A guest can refuse as fast as it can connect: each reason logs its 1st, 2nd, 4th, 8th... refusal, with the count. A reason
   * with no refusal for `REFUSAL_QUIET_MS` counts from 1 again (S2 m2), so a later burst is not hidden behind an old count.
   */
  const refusals = new Map<Refusal, { count: number; at: number }>();
  const refusedLog = (agentId: string | null, reason: Refusal): void => {
    const last = refusals.get(reason);
    const now = clock.now();
    const count = last !== undefined && now - last.at < REFUSAL_QUIET_MS ? last.count + 1 : 1;
    refusals.set(reason, { count, at: now });
    if ((count & (count - 1)) === 0) logger.warn("agent_gateway_refused", { agentId, reason, count });
  };

  function accept(socket: GatewaySocket): void {
    const release = stopped ? null : limits.admit(socket.remoteAddress ?? "unknown");
    if (release === null) {
      if (!stopped) refusedLog(null, "busy");
      socket.destroy();
      return;
    }
    let done = false;
    let accepted = false;
    let agentId: string | null = null;
    let role: WorkerConnection | null = null;
    let outstanding = 0;
    let helloTimer: TimerHandle | undefined;
    let pingTimer: TimerHandle | undefined;
    // Two reasons to read nothing: the byte window is used up, or a long line is parsed (R32). Resumed when neither holds.
    let meterPaused = false;
    let mirrorPaused = false;
    const meter = limits.meter(
      () => {
        meterPaused = true;
        socket.pause();
      },
      () => {
        meterPaused = false;
        if (!mirrorPaused) socket.resume();
      },
    );

    const close = (): void => {
      if (done) return;
      done = true;
      decoder.stop();
      if (helloTimer) clock.clearTimeout(helloTimer);
      if (pingTimer) clock.clearTimeout(pingTimer);
      release();
      meter.stop();
      open.delete(close);
      socket.destroy();
      role?.closed();
    };
    const refuse = (who: string | null, reason: Refusal): void => {
      refusedLog(who, reason);
      close();
    };
    const wire: Wire = {
      send(frame) {
        if (done) return false;
        let bytes: Buffer;
        try {
          bytes = encodeSocketFrame(frame);
        } catch {
          return false;
        }
        socket.write(bytes);
        if (socket.writableLength > GATEWAY_LIMITS.writeBacklogBytes) {
          logger.warn("agent_gateway_backlog", { agentId });
          close();
          return false;
        }
        return true;
      },
      close,
      pause() {
        mirrorPaused = true;
        socket.pause();
      },
      resume() {
        mirrorPaused = false;
        if (!meterPaused) socket.resume();
      },
    };

    const tick = (): void => {
      pingTimer = undefined;
      if (outstanding >= GATEWAY_PING_MISSES) {
        logger.warn("agent_gateway_ping_timeout", { agentId });
        close();
        return;
      }
      outstanding++;
      wire.send({ type: "ping" });
      if (!done) pingTimer = clock.setTimeout(tick, GATEWAY_PING_MS);
    };

    const onHello = (value: unknown): void => {
      const parsed = Hello.safeParse(value);
      if (!parsed.success) return refuse(null, isHelloWithOtherProtocol(value) ? "protocol" : "bad_hello");
      const hello = parsed.data;
      if (!tokens.check(hello.agentId, hello.launchId, hello.token)) return refuse(hello.agentId, "token");
      if (imageOf(hello.launchId) !== hello.imageTag) return refuse(hello.agentId, "image");
      if (hello.role === "guest") {
        if (everSeen.has(hello.launchId)) return refuse(hello.agentId, "duplicate");
        everSeen.add(hello.launchId);
        const guest = createGuestLink({ clock, logger, agentId: hello.agentId, wire });
        guests.set(hello.launchId, guest);
        role = {
          frame: guest.frame,
          closed: () => {
            guests.delete(hello.launchId);
            guest.closed();
          },
        };
        for (const waiter of waiters.get(hello.launchId) ?? []) {
          if (waiter.timer) clock.clearTimeout(waiter.timer);
          waiter.resolve(guest.link);
        }
        waiters.delete(hello.launchId);
      } else {
        const guest = guests.get(hello.launchId);
        if (!guest) return refuse(hello.agentId, "slot");
        const result = guest.acceptWorker(hello, wire);
        if (typeof result === "string") return refuse(hello.agentId, result);
        role = result;
      }
      agentId = hello.agentId;
      accepted = true;
      if (helloTimer) clock.clearTimeout(helloTimer);
      helloTimer = undefined;
      release();
      pingTimer = clock.setTimeout(tick, GATEWAY_PING_MS);
    };

    const onFrame = (value: unknown): void => {
      try {
        if (!accepted) return onHello(value);
        if (TransportPong.safeParse(value).success) {
          outstanding = 0;
          return;
        }
        if (TransportPing.safeParse(value).success) {
          wire.send({ type: "pong" });
          return;
        }
        role?.frame(value);
      } catch (error) {
        logger.error("agent_gateway_handler_failed", { agentId, err: error });
        close();
      }
    };

    const decoder = createFrameDecoder({
      maxBytes: () => (accepted ? AGENT_VM_MAX_FRAME_BYTES : HELLO_MAX_BYTES),
      onFrame,
      onError(error) {
        if (!accepted) return refuse(null, error === "too_large" ? "too_large" : "bad_hello");
        logger.warn("agent_gateway_frame_error", { agentId, error });
        close();
      },
    });
    open.add(close);
    helloTimer = clock.setTimeout(() => refuse(null, "timeout"), HELLO_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      if (done) return;
      meter.add(chunk.length);
      decoder.push(chunk);
    });
    socket.on("close", close);
    socket.on("error", close);
  }

  return {
    accept,
    listen: () => Promise.reject(new Error("the core has no listener")),
    awaitGuest(launchId) {
      if (stopped) return Promise.reject(new PapError("worker_failed"));
      const live = guests.get(launchId);
      if (live) return Promise.resolve(live.link);
      // AVM-E10: a launch has one guest in its lifetime; one that left cannot come back, so nobody waits for it.
      if (everSeen.has(launchId)) return Promise.reject(new PapError("worker_failed"));
      return new Promise<GuestLink>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, timer: undefined };
        const mine = waiters.get(launchId) ?? new Set<Waiter>();
        waiters.set(launchId, mine);
        mine.add(waiter);
        waiter.timer = clock.setTimeout(() => {
          mine.delete(waiter);
          if (mine.size === 0) waiters.delete(launchId);
          reject(new PapError("timeout"));
        }, GUEST_BOOT_TIMEOUT_MS);
      });
    },
    close() {
      stopped = true;
      for (const close of [...open]) close();
      for (const set of waiters.values()) {
        for (const waiter of set) {
          if (waiter.timer) clock.clearTimeout(waiter.timer);
          waiter.reject(new PapError("worker_failed"));
        }
      }
      waiters.clear();
      return Promise.resolve();
    },
  };
}

export function createGateway(deps: GatewayDeps): Gateway {
  const core = createGatewayCore(deps);
  let server: Server | undefined;
  return {
    listen(host, port) {
      return new Promise((resolve, reject) => {
        const listening = createServer((socket) => core.accept(socket));
        listening.once("error", reject);
        listening.listen(port, host, () => {
          listening.off("error", reject);
          listening.on("error", (error) => deps.logger.warn("agent_gateway_server_error", { err: error }));
          server = listening;
          resolve({ port: (listening.address() as AddressInfo).port });
        });
      });
    },
    awaitGuest: core.awaitGuest,
    async close() {
      await core.close();
      const closing = server;
      server = undefined;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
    },
  };
}

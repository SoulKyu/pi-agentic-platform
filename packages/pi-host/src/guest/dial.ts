import type net from "node:net";
import {
  AGENT_VM_PROTOCOL,
  encodeSocketFrame,
  parseBoxKey,
  TerminalHello,
  TunnelHello,
} from "@pap/contracts/pi-host";
import { errorClass } from "../bounded.ts";
import type { GuestClock } from "./guest.ts";

/** A side connection that has not connected by then is destroyed (the daemon waits 15 s from the command to the hello). */
export const SIDE_CONNECT_MS = 10_000;

export interface DialDeps {
  /** The guest's own environment (already scrubbed of the token): the gateway address and the box identity. */
  readonly env: NodeJS.ProcessEnv;
  /** The gateway token: said in the hello from memory, never in an environment. */
  readonly token: string;
  readonly clock: GuestClock;
  connect(address: string): net.Socket;
  log?(line: string): void;
}

export interface SideHello {
  readonly role: "terminal" | "tunnel";
  readonly slot: string;
}

/** The hello of a side connection, or null when the guest's identity or the slot does not parse. */
export function sideHello(
  deps: Pick<DialDeps, "env" | "token">,
  hello: SideHello,
): (typeof TerminalHello)["_output"] | (typeof TunnelHello)["_output"] | null {
  const fields = {
    type: "hello",
    role: hello.role,
    box: parseBoxKey(deps.env.PAP_BOX ?? ""),
    launchId: deps.env.PAP_LAUNCH_ID,
    token: deps.token,
    protocol: AGENT_VM_PROTOCOL,
    imageTag: deps.env.PAP_IMAGE_TAG,
    slot: hello.slot,
  };
  const parsed = hello.role === "terminal" ? TerminalHello.safeParse(fields) : TunnelHello.safeParse(fields);
  return parsed.success ? parsed.data : null;
}

/**
 * A connection to the gateway that has said its hello (a terminal's or a tunnel's, named by its slot). Rejects when the hello
 * does not parse, when the connection fails, or when it has not connected after `SIDE_CONNECT_MS`.
 */
export function dialSide(deps: DialDeps, hello: SideHello): Promise<net.Socket> {
  const address = deps.env.PAP_GATEWAY;
  const greeting = sideHello(deps, hello);
  if (greeting === null || !address) return Promise.reject(new Error("the side hello is invalid"));
  return new Promise((resolve, reject) => {
    const socket = deps.connect(address);
    let connected = false;
    const timer = deps.clock.setTimeout(
      () => socket.destroy(new Error("connect timed out")),
      SIDE_CONNECT_MS,
    );
    const refuse = (error?: Error): void => {
      if (connected) return;
      deps.clock.clearTimeout(timer);
      socket.destroy();
      reject(error ?? new Error("the side connection closed"));
    };
    socket.once("error", refuse);
    socket.once("close", () => refuse());
    socket.once("connect", () => {
      connected = true;
      deps.clock.clearTimeout(timer);
      socket.off("error", refuse);
      // The consumer attaches its own listeners a tick later: an error in between must not be uncaught.
      socket.on("error", (error) => deps.log?.(`side connection error: ${errorClass(error)}`));
      socket.setNoDelay(true);
      socket.write(encodeSocketFrame(greeting));
      resolve(socket);
    });
  });
}

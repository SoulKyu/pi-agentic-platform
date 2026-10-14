import type { z } from "zod";
import type { Cursor } from "./frames.ts";
import type { methods } from "./methods.ts";
import type { Permission } from "./permissions.ts";
import type { StreamName } from "./streams.ts";

export type MethodName = keyof typeof methods;
export type ParamsOf<M extends MethodName> = z.output<(typeof methods)[M]["params"]>;
export type ResultOf<M extends MethodName> = z.input<(typeof methods)[M]["result"]>;

export interface Caller {
  readonly userId: string;
  readonly permissions: ReadonlySet<Permission>;
  /** How the transport authenticated the caller: a browser session cookie or a `pap_` bearer token (Task 14). */
  readonly kind: "session" | "token";
  /** The browser session's public id (Task 15; "" before it) or the token's id; never a secret. */
  readonly credentialId: string;
  /** Until when (clock ms) the caller confirmed the password (step-up, Task 13a); 0 or past: not confirmed. */
  readonly stepUpUntil: number;
}

/** One attached binary stream of this connection (Task 2). `send` is false while the stream is not committed, closed, or
 * while the socket buffers more than 1 MiB: the caller pauses and tries again later (Task 11). */
export interface BinaryStream {
  readonly streamId: number;
  send(op: "output" | "reset" | "exit", seq: number, payload: Uint8Array): boolean;
  close(): void;
}
export interface BinarySink {
  /** The RPC answer that created the stream reached the client: frames may flow. */
  onOpen(): void;
  onInput(seq: number, payload: Uint8Array): void;
  onAck(seq: number): void;
  /** The stream ended: closed by the sink, the socket, a revocation or a failed request. Called once. */
  onClose(): void;
}
export interface BinaryChannel {
  /** Throws `PapError("capacity")` past 16 streams on this connection. */
  open(sink: BinarySink): BinaryStream;
}

export interface HandlerContext {
  readonly caller: Caller;
  readonly connectionId: string;
  openSubscription(stream: StreamName, key: string, after: Cursor | undefined): string;
  closeSubscription(sub: string): void;
  /** Set by the ws server; a handler that needs it and finds none answers `internal` (M8R4). */
  readonly binary?: BinaryChannel;
}

export type Handler<M extends MethodName> = (
  params: ParamsOf<M>,
  ctx: HandlerContext,
) => Promise<ResultOf<M>>;
export type HandlerTable = { readonly [M in MethodName]: Handler<M> };

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

export interface HandlerContext {
  readonly caller: Caller;
  readonly connectionId: string;
  openSubscription(stream: StreamName, key: string, after: Cursor | undefined): string;
  closeSubscription(sub: string): void;
}

export type Handler<M extends MethodName> = (
  params: ParamsOf<M>,
  ctx: HandlerContext,
) => Promise<ResultOf<M>>;
export type HandlerTable = { readonly [M in MethodName]: Handler<M> };

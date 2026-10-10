import type { z } from "zod";
import type { ErrorCode } from "./errors.ts";
import type { Permission } from "./permissions.ts";

export interface MethodDef<
  N extends string = string,
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  readonly name: N;
  readonly permission: Permission;
  readonly idempotent: boolean;
  readonly params: P;
  readonly result: R;
  readonly errors: readonly ErrorCode[];
}

export function defineMethod<const N extends string, P extends z.ZodType, R extends z.ZodType>(
  def: MethodDef<N, P, R>,
): MethodDef<N, P, R> {
  return def;
}

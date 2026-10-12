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
  /**
   * The result holds a secret shown once (an API token, R69). The dispatcher stores no result for it: a replay of the
   * same commandId answers `conflict`, never the secret again (Task 13b).
   */
  readonly secretResult?: true;
  readonly params: P;
  readonly result: R;
  readonly errors: readonly ErrorCode[];
}

export function defineMethod<const N extends string, P extends z.ZodType, R extends z.ZodType>(
  def: MethodDef<N, P, R>,
): MethodDef<N, P, R> {
  return def;
}

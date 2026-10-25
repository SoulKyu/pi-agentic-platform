import { useHelperStatus } from "./launch-store.ts";
import { useBoxPhase } from "./box-phase.ts";

/** A message key and its values: the caller translates (`t(cause.key, cause.vars)`) after importing `i18n/register-launch.ts`. `stores/` does not import the catalogs. */
export interface LoadingCause {
  readonly key: "loading.cause.pi" | "loading.cause.piWaiting" | "loading.cause.box";
  readonly vars?: Readonly<Record<string, number>>;
}

/** Why a read is slow when it goes through a box. */
export const boxCause: LoadingCause = { key: "loading.cause.box" };

/** Pi as the cause: reads queued first, else several at once. Nothing when Pi is idle enough. */
export function piCauseOf(status: {
  readonly active: number;
  readonly waiting: number;
}): LoadingCause | undefined {
  if (status.waiting > 0) return { key: "loading.cause.piWaiting", vars: { waiting: status.waiting } };
  if (status.active > 1) return { key: "loading.cause.pi", vars: { active: status.active } };
  return undefined;
}

/** The cause of a Pi-bound wait, from the `helpers` stream. */
export function usePiCause(): LoadingCause | undefined {
  return piCauseOf(useHelperStatus());
}

/** `usePiCause` translated by the caller's `t`, for `LoadingLine`'s `cause`. The caller imports `i18n/register-launch.ts`. */
export function usePiCauseText(
  t: (key: LoadingCause["key"], vars?: Record<string, number>) => string,
): string | undefined {
  const cause = usePiCause();
  return cause === undefined ? undefined : t(cause.key, cause.vars);
}

/** The cause text of a read through the box holding `path`: nothing for a host path. The caller imports `i18n/register-launch.ts`. */
export function useBoxCauseText(t: (key: LoadingCause["key"]) => string, path: string): string | undefined {
  return useBoxPhase(path) === null ? undefined : t(boxCause.key);
}

import { UsageError } from "../usage.ts";
import type { Check, CheckResult, DoctorContext, DoctorReport } from "./types.ts";

export const CHECK_DEADLINE_MS = 10_000;

const THREW: CheckResult = { status: "fail", detail: "the check could not run", fix: "report this" };

/** One check, bounded by `ctx.clock`; a throw is a fixed sentence (never the error text), a slow check a warn. */
async function runOne(check: Check, ctx: DoctorContext): Promise<CheckResult> {
  let timer: ReturnType<DoctorContext["clock"]["setTimeout"]> | undefined;
  const late = new Promise<CheckResult>((resolve) => {
    timer = ctx.clock.setTimeout(
      () =>
        resolve({
          status: "warn",
          detail: `timed out after ${CHECK_DEADLINE_MS / 1000} s`,
          fix: `pap doctor --only ${check.id}`,
        }),
      CHECK_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([(async () => check.run(ctx))(), late]);
  } catch {
    return THREW;
  } finally {
    if (timer !== undefined) ctx.clock.clearTimeout(timer);
  }
}

/** Runs the checks one after the other in registry order. An id in `only` that no check has is a usage error. */
export async function runDoctor(
  checks: readonly Check[],
  ctx: DoctorContext,
  only?: readonly string[],
): Promise<DoctorReport> {
  const known = checks.map((check) => check.id);
  const unknown = (only ?? []).filter((id) => !known.includes(id));
  if (unknown.length > 0)
    throw new UsageError(`unknown check ${unknown.join(", ")}; the checks are: ${known.join(", ")}`);
  const results: Array<DoctorReport["results"][number]> = [];
  for (const check of checks) {
    if (only !== undefined && !only.includes(check.id)) continue;
    results.push({ id: check.id, title: check.title, ...(await runOne(check, ctx)) });
  }
  const exit = results.some((r) => r.status === "fail")
    ? 1
    : results.some((r) => r.status === "warn")
      ? 2
      : 0;
  return { results, exit };
}

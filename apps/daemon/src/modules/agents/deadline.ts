import type { Clock } from "../../kernel/clock.ts";

/**
 * `work`, or a rejection once `ms` have passed on the clock (the timer is cleared on every path). The work itself is not
 * cancelled: whoever gave it a deadline decides what a late answer means.
 */
export function withDeadline<T>(
  work: Promise<T>,
  clock: Pick<Clock, "setTimeout" | "clearTimeout">,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error("deadline")), ms);
    work.then(
      (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

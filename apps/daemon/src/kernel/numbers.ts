/** A count read from untrusted JSON (a worker's answer, a Pi file): a non-negative safe integer and nothing else. */
export const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

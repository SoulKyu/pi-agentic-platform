/** For a stored document that once held a key pap no longer reads: the key is accepted and dropped, never refused. */
export const dropKey =
  (key: string) =>
  (value: unknown): unknown =>
    typeof value === "object" && value !== null && key in value
      ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
      : value;

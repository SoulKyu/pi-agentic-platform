/** SQLite refusing a write on a database opened read-only: a database written by a newer pap (spec C 3.4). */
export const isReadOnlyError = (error: unknown): boolean =>
  error instanceof Error && /readonly database/i.test(error.message);

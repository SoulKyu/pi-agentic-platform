/** SQLite's primary code (the low byte of an extended one) says the file is damaged: 11 CORRUPT, 26 NOTADB (M4R44). */
export const isDamagedCode = (errcode: unknown): boolean =>
  typeof errcode === "number" && ((errcode & 0xff) === 11 || (errcode & 0xff) === 26);

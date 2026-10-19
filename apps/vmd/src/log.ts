/** One record per event: stable names and bounded fields, never a token, an env file's text or a command's output. */
export interface Logger {
  info(event: string, fields: Record<string, unknown>): void;
}

export function createStderrLogger(): Logger {
  return {
    info(event, fields) {
      process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
    },
  };
}

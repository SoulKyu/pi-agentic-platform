/** A command line the CLI cannot read: exit code 64, the message and the usage. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const PREVIEW_STOP_COMMAND = "systemctl --user stop pap-preview";

export const USAGE = [
  "usage: pap serve [--dev] [--host <address>] [--port <port>] [--insecure-http] [--tls-cert <file> --tls-key <file>]",
  "       pap audit prune [--month YYYY-MM] [--dry-run]",
  "       pap user add <username> [--password-stdin]",
  "       pap passkey reset [--revoke-tokens] [--keep-password] [--password-stdin]",
  "       pap trace summary [--since <15m|2h|1d>]",
  "The admin commands (everything but serve and trace summary) need the daemon stopped; for the preview service:",
  `  ${PREVIEW_STOP_COMMAND}`,
  "",
].join("\n");

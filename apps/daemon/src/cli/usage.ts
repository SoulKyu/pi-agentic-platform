/** A command line the CLI cannot read: exit code 64, the message and the usage. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const PREVIEW_STOP_COMMAND = "systemctl --user stop pap-preview";

export const USAGE = [
  "usage: pap serve [--dev] [--host <address>] [--port <port>] [--insecure-http] [--tls-cert <file> --tls-key <file>]",
  "       pap audit prune [--month YYYY-MM] [--dry-run]",
  "       pap backup [--out <abs dir>] [--skip <attachments|agents|exports|pi>]... [--allow-large] [--keep N] [--encrypt [--secrets include] [--passphrase-stdin]] [--unit <name>] [--home <abs dir>]",
  "       pap restore <backup file> [--replace] [--passphrase-stdin] [--home <abs dir>] [--unit <name>]",
  "       pap user add <username> [--password-stdin]",
  "       pap passkey reset [--revoke-tokens] [--keep-password] [--password-stdin]",
  "       pap trace summary [--since <15m|2h|1d>]",
  "       pap service install [--node <abs>] [--main <abs>] [--port <1-65535>] [--home <abs>] [--bin-dir <abs>]",
  "       pap service uninstall [--bin-dir <abs>]",
  "       pap service url",
  "       pap update check [--channel stable|next]",
  "       pap update install [--channel stable|next] [--from <abs dir>] [--yes]",
  "       pap update apply --release <id> [--app-root <abs>] [--deadline-s 30..600] [--settle-s 0..60] [--unit <name>]",
  "       pap update rollback [--to <id>] [--restore-database | --keep-database] [--app-root <abs>] [--unit <name>]",
  "       pap update recover [--keep-database] [--app-root <abs>] [--unit <name>]",
  "       pap doctor [--json] [--only id[,id...]] [--unit <name>] [--home <abs dir>]",
  "backup --keep N keeps the new backup and the N most recent older pap-backup-* files of the output folder",
  "The admin commands (everything but serve, backup, update, doctor, trace summary and service) need the daemon stopped (restore included); for the preview service:",
  `  ${PREVIEW_STOP_COMMAND}`,
  "",
].join("\n");

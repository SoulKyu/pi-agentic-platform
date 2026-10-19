import { parseArgs, type ParseArgsConfig } from "node:util";
import { MigrationError } from "../kernel/db/migrate.ts";
import { HomeError, InstanceLockError } from "../kernel/home.ts";
import { ConfigError } from "../kernel/config.ts";
import { AuthCliError } from "../modules/auth/index.ts";
import { auditPrune } from "./audit-prune.ts";
import { backup } from "./backup.ts";
import { doctor } from "./doctor.ts";
import { CliError, type CliIo } from "./open-home.ts";
import { passkeyReset } from "./passkey-reset.ts";
import { restore } from "./restore.ts";
import { serviceInstall } from "./service/install.ts";
import { serviceUninstall } from "./service/uninstall.ts";
import { serviceUrl } from "./service/url.ts";
import { traceSummary } from "./trace-summary.ts";
import { updateApply } from "./update/apply-command.ts";
import { updateCheck } from "./update/check-command.ts";
import { updateInstall } from "./update/install-command.ts";
import { updateRecover } from "./update/recover-command.ts";
import { updateRollback } from "./update/rollback-command.ts";
import { PREVIEW_STOP_COMMAND, USAGE, UsageError } from "./usage.ts";
import { userAdd } from "./user-add.ts";
import { vmSetup } from "./vm/setup.ts";
import { vmUninstall } from "./vm/uninstall.ts";

export interface Command {
  readonly options: NonNullable<ParseArgsConfig["options"]>;
  run(call: {
    values: Record<string, string | boolean | Array<string | boolean> | undefined>;
    positionals: string[];
    io: CliIo;
  }): Promise<number>;
}

/** Keyed by the command words. `USAGE` lists the same commands. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  "audit prune": auditPrune,
  backup,
  restore,
  "user add": userAdd,
  "passkey reset": passkeyReset,
  "trace summary": traceSummary,
  "service install": serviceInstall,
  "service uninstall": serviceUninstall,
  "service url": serviceUrl,
  "update check": updateCheck,
  "update install": updateInstall,
  "update apply": updateApply,
  "update rollback": updateRollback,
  "update recover": updateRecover,
  "vm setup": vmSetup,
  "vm uninstall": vmUninstall,
  doctor,
};

const usage = (io: CliIo, message?: string): number => {
  io.stderr.write(`${message === undefined ? "" : `pap: ${message}\n`}${USAGE}`);
  return 64;
};

/** The admin commands. `serve` is not one of them: it lives in `main.ts`. Returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [first, second] = argv;
  const pair = first === undefined || second === undefined ? undefined : `${first} ${second}`;
  const words = pair !== undefined && Object.hasOwn(COMMANDS, pair) ? pair : first;
  const command = words !== undefined && Object.hasOwn(COMMANDS, words) ? COMMANDS[words] : undefined;
  if (!command) return usage(io);
  const rest = argv.slice(words === pair ? 2 : 1);
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: command.options,
      strict: true,
      allowPositionals: true,
    });
    return await command.run({ values, positionals, io });
  } catch (error) {
    if (error instanceof UsageError) return usage(io, error.message);
    if ((error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))
      return usage(io, (error as Error).message);
    if (
      error instanceof CliError ||
      error instanceof AuthCliError ||
      error instanceof InstanceLockError ||
      error instanceof HomeError ||
      error instanceof MigrationError ||
      error instanceof ConfigError
    ) {
      io.stderr.write(`pap: ${error.message}\n`);
      if (error instanceof InstanceLockError && error.message.startsWith("pap is already running"))
        io.stderr.write(`pap: for the preview service: ${PREVIEW_STOP_COMMAND}\n`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    throw error;
  }
}

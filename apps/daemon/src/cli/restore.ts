import { resolve } from "node:path";
import { piAgentDirFrom } from "../kernel/pi-dir.ts";
import { installedUnitText, SOURCE_TEXT } from "./backup.ts";
import { restoreBackup, RestoreError, type RestoreResult } from "./backup/restore.ts";
import { mismatch, resolveTarget, UNIT_NAME, type HomeSource } from "./ops/target.ts";
import { CliError, type CliIo } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import type { Command } from "./run-cli.ts";
import { UsageError } from "./usage.ts";

const MISSING_SECRETS =
  "Without them the vault key and values, the webhook keys and the known-device key are missing: re-enter agent secrets, rotate webhook secrets.";
const NOTIFICATIONS = "Notifications: each device re-enables when it next opens pap.";

/** The text of a restore's result: fixed sentences, the folders it kept and what to do next. */
export function renderRestoreSummary(input: {
  result: RestoreResult;
  file: string;
  home: string;
  homeSource: HomeSource;
  unit: string;
}): string {
  const { result, file, home, homeSource, unit } = input;
  const lines = [
    `restored: ${file}`,
    `home: ${home} (from ${SOURCE_TEXT[homeSource]})`,
    `database: state.db restored (${result.manifest.schema.length} migrations, written by pap ${result.manifest.papVersion})`,
    `folders restored: ${result.tops.length === 0 ? "none" : result.tops.join(", ")}`,
  ];
  const kept = [result.keptDatabase, result.keptFolders].filter((path): path is string => path !== null);
  if (kept.length > 0)
    lines.push(
      `kept: ${kept.join(" and ")} (what the restore replaced; if the process is cut short, the old data is there)`,
    );
  if (result.secretsRestored) lines.push("secrets: restored");
  else lines.push("secrets: not restored (an existing secrets folder was left as it is)", MISSING_SECRETS);
  if (!result.vapidRestored) lines.push(NOTIFICATIONS);
  lines.push(
    `Pi sessions: ${result.piAdded} added, ${result.piSkipped} skipped (an existing file is never overwritten)${result.piNote === null ? "" : `; ${result.piNote}`}`,
  );
  lines.push(...result.warnings);
  lines.push(`start pap: systemctl --user start ${unit}`, "");
  return lines.join("\n");
}

/** A terminal asks once (a wrong passphrase only fails); otherwise, or with `--passphrase-stdin`, the first line of standard input. */
const readPassphrase = (io: CliIo, fromStdin: boolean): Promise<string> =>
  fromStdin || io.stdin.isTTY !== true
    ? readSecret(io, "Passphrase: ", { line: true, noun: "passphrase" })
    : readSecret(io, "Passphrase: ", { noun: "passphrase" });

/** `pap restore <file>`: stops nothing, refuses while the daemon runs, and keeps whatever it replaces. */
export const restore: Command = {
  options: {
    replace: { type: "boolean" },
    "passphrase-stdin": { type: "boolean" },
    home: { type: "string" },
    unit: { type: "string" },
  },
  async run({ values, positionals, io }) {
    const [name, ...rest] = positionals;
    if (name === undefined || rest.length > 0) throw new UsageError("restore takes one backup file");
    const text = (value: unknown, flag: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string") throw new UsageError(`--${flag} needs a value`);
      return value;
    };
    const unit = text(values.unit, "unit");
    if (unit !== undefined && !UNIT_NAME.test(unit))
      throw new UsageError("--unit must look like pap.service");
    const fromStdin = values["passphrase-stdin"] === true;
    if (fromStdin && io.stdin.isTTY === true)
      throw new UsageError(
        "--passphrase-stdin reads a pipe, and standard input is a terminal: omit the flag to use the prompt, or pipe the passphrase",
      );
    const args = { unit, home: text(values.home, "home") };

    const named = resolveTarget(args, io.env, io.homedir, null);
    const unitText = await installedUnitText(io, named.unit);
    const target = resolveTarget(args, io.env, io.homedir, unitText);
    if (unitText !== null && target.parsed === null && target.homeSource !== "flag")
      throw new CliError(
        `${target.unit} is not a unit pap wrote, so its data folder is unknown: pass --home <abs dir> to say which one to restore into`,
      );
    const refusal = mismatch(target);
    if (refusal !== null) throw new CliError(refusal);

    const file = resolve(name);
    try {
      const result = await restoreBackup({
        home: target.home,
        piDir: piAgentDirFrom(io.env, io.homedir),
        file,
        replace: values.replace === true,
        now: new Date(io.clock.now()),
        passphrase: () => readPassphrase(io, fromStdin),
      });
      io.stdout.write(
        renderRestoreSummary({
          result,
          file,
          home: target.home,
          homeSource: target.homeSource,
          unit: target.unit,
        }),
      );
      return 0;
    } catch (error) {
      if (error instanceof RestoreError) throw new CliError(error.message);
      throw error;
    }
  },
};

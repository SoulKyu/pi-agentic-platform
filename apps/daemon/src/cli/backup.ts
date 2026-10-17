import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { VERSION } from "../kernel/version.ts";
import { piAgentDirFrom } from "../kernel/pi-dir.ts";
import { encryptStream, MIN_PASSPHRASE, passphraseTooShort } from "./backup/crypto.ts";
import { BackupError, createBackup, type BackupResult } from "./backup/create.ts";
import { listMembers, RESTORE_LIMITS } from "./backup/tar-list.ts";
import { mismatch, resolveTarget, UNIT_NAME, type HomeSource } from "./ops/target.ts";
import { CliError, type CliIo } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import type { Command } from "./run-cli.ts";
import { unitFilePath } from "./service/common.ts";
import { createSystemd } from "./service/systemd.ts";
import { UsageError } from "./usage.ts";

const SKIPPABLE = ["attachments", "agents", "exports", "pi"] as const;
type Skippable = (typeof SKIPPABLE)[number];

export const SOURCE_TEXT: Record<HomeSource, string> = {
  flag: "the flag",
  environment: "the environment",
  unit: "the unit",
  default: "the default",
};
const TOP_TEXT: Record<BackupResult["tops"][number], string> = {
  attachments: "attachments",
  agents: "agents",
  exports: "exports",
  secrets: "secrets",
  "pi-agent": "Pi sessions",
};
const SENSITIVE =
  "The secrets folder is not included. Transcripts and agent files may still contain secrets: treat this file as sensitive, and use --encrypt before copying it off this machine.";

const ENCRYPTED = "encrypted: yes (scrypt and AES-256-GCM). pap cannot recover a lost passphrase.";
const ENCRYPTED_SENSITIVE =
  "Transcripts and agent files may contain secrets: the file is encrypted, so only the passphrase opens it.";
const PASSPHRASE_NOTICE = "This passphrase protects the backup file; pap cannot recover it.";

function secretsLine(result: BackupResult, requested: "exclude" | "include"): string {
  if (result.secretsIncluded) return "secrets: included";
  if (requested === "include") return "secrets: requested, but the secrets folder is empty or absent";
  return result.encrypted
    ? "secrets: not included (use --secrets include)"
    : "secrets: not included (use --secrets include with --encrypt)";
}

/** The text of a backup's result: fixed sentences, the counts and the first few skipped paths. */
export function renderSummary(input: {
  result: BackupResult;
  home: string;
  homeSource: HomeSource;
  skip: ReadonlySet<string>;
  secrets: "exclude" | "include";
}): string {
  const { result, home, homeSource, skip, secrets } = input;
  const { links, names, changed } = result.skipped;
  const lines = [
    `backup written: ${result.path} (${result.bytes} bytes)`,
    `home: ${home} (from ${SOURCE_TEXT[homeSource]})`,
    `included: ${["state.db", ...result.tops.map((top) => TOP_TEXT[top])].join(", ")}`,
    "not included: search.db, worktrees, lanes, tmp, logs, backups, update, pap.lock, Pi auth.json, models.json and extensions",
  ];
  if (skip.size > 0) lines.push(`left out by --skip: ${[...skip].sort().join(", ")}`);
  if (result.encrypted) lines.push(ENCRYPTED);
  lines.push(secretsLine(result, secrets), result.encrypted ? ENCRYPTED_SENSITIVE : SENSITIVE);
  if (links + names + changed > 0) {
    const first = result.examples.length > 0 ? ` (${result.examples.join(", ")})` : "";
    lines.push(
      `skipped: ${links} symbolic links or special files, ${names} names or folders the restore would refuse, ${changed} entries that changed during the backup${first}`,
    );
  }
  if (links > 0)
    lines.push(
      "Symbolic links, including those inside git working trees under agents/, are not in the backup.",
    );
  if (result.tarChanged)
    lines.push(
      "Files that changed during the backup may be incomplete (for example a transcript being written).",
    );
  if (result.pruned > 0) lines.push(`removed ${result.pruned} older backups`);
  lines.push("copy this file off this machine: a backup on the same disk is not a backup", "");
  return lines.join("\n");
}

/** The effective text of the installed unit (`systemctl cat`), else the unit file; null when no unit is installed. */
export async function installedUnitText(io: CliIo, unit: string): Promise<string | null> {
  const systemd = createSystemd(io.env, { unit });
  try {
    if (await systemd.userManagerUp())
      return (await systemd.loadState(unit)) === "loaded" ? await systemd.cat(unit) : null;
  } catch (error) {
    if (!(error instanceof CliError)) throw error; // no systemd here: the unit file is the next best source
  }
  try {
    return readFileSync(unitFilePath(io, unit), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`${unit} could not be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

const text = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`--${name} needs a value`);
  return value;
};

/** The passphrase: a terminal asks twice; otherwise (or with `--passphrase-stdin`) the first line of standard input. */
async function readPassphrase(io: CliIo, fromStdin: boolean): Promise<string> {
  const line = fromStdin || io.stdin.isTTY !== true;
  let passphrase: string;
  if (line) passphrase = await readSecret(io, "Passphrase: ", { line: true, noun: "passphrase" });
  else {
    io.stdout.write(`${PASSPHRASE_NOTICE}\n`);
    passphrase = await readSecret(io, "Passphrase: ", { noun: "passphrase" });
    if (passphrase !== (await readSecret(io, "Again: ", { noun: "passphrase" })))
      throw new CliError("the two passphrases differ");
  }
  if (passphraseTooShort(passphrase))
    throw new CliError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  return passphrase;
}

/** `pap backup`: one archive, plain or encrypted. Needs no instance lock and does not stop the daemon. */
export const backup: Command = {
  options: {
    out: { type: "string" },
    skip: { type: "string", multiple: true },
    "allow-large": { type: "boolean" },
    keep: { type: "string" },
    unit: { type: "string" },
    home: { type: "string" },
    secrets: { type: "string" },
    encrypt: { type: "boolean" },
    "passphrase-stdin": { type: "boolean" },
  },
  async run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("backup takes no argument");
    const skip = new Set<Skippable>();
    for (const value of (values.skip as string[] | undefined) ?? []) {
      if (!(SKIPPABLE as readonly string[]).includes(value))
        throw new UsageError(`--skip takes ${SKIPPABLE.join(", ")}`);
      skip.add(value as Skippable);
    }
    const keepText = text(values.keep, "keep");
    if (keepText !== undefined && !/^\d{1,3}$/.test(keepText))
      throw new UsageError("--keep takes a number from 1 to 100");
    const keep = keepText === undefined ? undefined : Number(keepText);
    if (keep !== undefined && (keep < 1 || keep > 100))
      throw new UsageError("--keep takes a number from 1 to 100");
    const out = text(values.out, "out");
    if (out !== undefined && !isAbsolute(out)) throw new UsageError("--out must be an absolute path");
    const unit = text(values.unit, "unit");
    if (unit !== undefined && !UNIT_NAME.test(unit))
      throw new UsageError("--unit must look like pap.service");
    const secrets = text(values.secrets, "secrets") ?? "exclude";
    if (secrets !== "exclude" && secrets !== "include")
      throw new UsageError("--secrets takes exclude or include");
    const encrypt = values.encrypt === true;
    if (secrets === "include" && !encrypt)
      throw new UsageError(
        "--secrets include needs --encrypt: a plain file would carry the vault key next to the vault",
      );
    if (values["passphrase-stdin"] === true && !encrypt)
      throw new UsageError("--passphrase-stdin needs --encrypt");
    if (values["passphrase-stdin"] === true && io.stdin.isTTY === true)
      throw new UsageError(
        "--passphrase-stdin reads a pipe, and standard input is a terminal: omit the flag to use the prompt, or pipe the passphrase",
      );
    const args = { unit, home: text(values.home, "home") };

    const named = resolveTarget(args, io.env, io.homedir, null);
    const unitText = await installedUnitText(io, named.unit);
    const target = resolveTarget(args, io.env, io.homedir, unitText);
    if (unitText !== null && target.parsed === null && target.homeSource !== "flag")
      throw new CliError(
        `${target.unit} is not a unit pap wrote, so its data folder is unknown: pass --home <abs dir> to say which one to back up`,
      );
    const refusal = mismatch(target);
    if (refusal !== null) throw new CliError(refusal);

    const passphrase = encrypt ? await readPassphrase(io, values["passphrase-stdin"] === true) : null;
    try {
      const result = await createBackup({
        home: target.home,
        piDir: piAgentDirFrom(io.env, io.homedir),
        outDir: out ?? join(target.home, "backups"),
        now: new Date(io.clock.now()),
        papVersion: VERSION,
        secrets,
        ...(passphrase === null
          ? {}
          : { encrypt: (plain: Readable, outPath: string) => encryptStream(plain, outPath, passphrase) }),
        skip,
        selfCheck: async (file) => {
          await listMembers(file, RESTORE_LIMITS);
        },
        allowLarge: values["allow-large"] === true,
        ...(keep === undefined ? {} : { keep }),
      });
      io.stdout.write(
        renderSummary({ result, home: target.home, homeSource: target.homeSource, skip, secrets }),
      );
      return 0;
    } catch (error) {
      if (error instanceof BackupError) throw new CliError(error.message);
      throw error;
    }
  },
};

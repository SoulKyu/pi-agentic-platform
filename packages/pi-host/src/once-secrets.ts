import { isVaultName, type VaultUpdateRecord } from "@pap/contracts/pi-host";
import { errorClass } from "./bounded.ts";
import type { SecretSource } from "./policy/secrets.ts";
import type { ShellEnvironment } from "./shell-env.ts";

/** The daemon holds at most this many per agent (`ONCE_LIMITS`); a record that lists more is said on stderr, never skipped silently. */
const MAX_WAITING = 3;
/** Values this worker already handed out, remembered until their own `expiresAt` so a record that lists one again cannot revive it. */
const MAX_CONSUMED = 64;

export interface OnceEntry {
  /** The daemon's random id of this value: the identity for the set, the used-memory and `secret_used`. Never the value. */
  readonly id: string;
  readonly name: string;
  readonly value: string;
  /** The daemon's expiry (ms since the epoch); the worker checks it on its own clock. */
  readonly expiresAt: number;
}

export interface OnceSecrets {
  /**
   * The daemon's list is authoritative (W5-R37): the whole set is replaced. A value this worker already used is not taken
   * back (and the daemon is told again, healing a lost `secret_used`); an expired one is not taken at all.
   */
  replace(entries: ReadonlyArray<OnceEntry>): void;
  /** Every value waiting now, oldest first, one entry per value (the redactor gets all of them). */
  entries(): OnceEntry[];
  /**
   * The command is about to run: every waiting name it spells `$NAME` or `${NAME}` (not the prefix of a longer name) gets its
   * oldest unexpired value, which is then forgotten and reported. A command that names nothing leaves all of them.
   */
  take(command: string): Record<string, string>;
}

/**
 * "Use once" (M11R105, owner m6): the value lives here, in the worker's memory, until the first sandboxed command whose text
 * names it. The daemon drops its copy when `used` reports the name. The value stays in the redactor until the worker
 * exits (`createVaultSink`).
 */
export function createOnceSecrets(hooks: {
  used(entry: { readonly name: string; readonly id: string }): void;
  now?: () => number;
}): OnceSecrets {
  const now = hooks.now ?? Date.now;
  let waiting: OnceEntry[] = [];
  const consumed: OnceEntry[] = [];
  const live = (): OnceEntry[] => {
    waiting = waiting.filter((entry) => entry.expiresAt > now());
    return waiting;
  };
  const report = (entry: OnceEntry): void => {
    try {
      hooks.used({ name: entry.name, id: entry.id });
    } catch (error) {
      // The class only: the daemon keeps its copy until its 24 hours are over; the value is not given back.
      process.stderr.write(`pi-host: secret_used not sent (${errorClass(error)})\n`);
    }
  };
  return {
    replace(entries) {
      const at = now();
      for (const gone of consumed.splice(0)) if (gone.expiresAt > at) consumed.push(gone);
      const next: OnceEntry[] = [];
      for (const entry of entries) {
        if (!isVaultName(entry.name) || entry.expiresAt <= at) continue;
        if (consumed.some((kept) => kept.id === entry.id)) {
          report(entry);
          continue;
        }
        if (next.some((kept) => kept.id === entry.id)) continue;
        if (next.length >= MAX_WAITING) {
          process.stderr.write(
            `pi-host: one-use value not held (more than ${MAX_WAITING}) for ${entry.name}\n`,
          );
          continue;
        }
        next.push({ id: entry.id, name: entry.name, value: entry.value, expiresAt: entry.expiresAt });
      }
      waiting = next;
    },
    entries: () => [...live()],
    take(command) {
      const env: Record<string, string> = {};
      for (const name of new Set(live().map((entry) => entry.name))) {
        if (!new RegExp(`\\$\\{?${name}\\}?(?![A-Za-z0-9_])`).test(command)) continue;
        const index = waiting.findIndex((entry) => entry.name === name);
        const [entry] = waiting.splice(index, 1);
        if (!entry) continue;
        env[name] = entry.value;
        consumed.push(entry);
        if (consumed.length > MAX_CONSUMED) consumed.shift();
        report(entry);
      }
      return env;
    },
  };
}

/** The sandboxed shell's environment plus the one-use value the command names; the vault part is the wrapped one's. */
export function withOnceSecrets(base: ShellEnvironment, once: Pick<OnceSecrets, "take">): ShellEnvironment {
  return {
    envFor: (command) => ({ ...base.envFor(command), ...once.take(command) }),
    setVault: (vault) => base.setVault(vault),
  };
}

/**
 * What a `vault_update` (and the init record) does in the worker: the redactor learns the vault and EVERY waiting one-use
 * value (one entry per value: two of one name are both redacted), the sandboxed shell's environment gets the vault, the
 * one-use values wait for their command. A value that leaves (used, expired, dropped by the daemon, or removed from the
 * vault) stays redacted until the worker exits: the previous set is retired, never forgotten.
 */
export function createVaultSink(deps: {
  readonly source: Pick<SecretSource, "setVault" | "setOnce">;
  readonly environment: Pick<ShellEnvironment, "setVault"> | undefined;
  readonly once: Pick<OnceSecrets, "replace" | "entries">;
}): { update(record: Pick<VaultUpdateRecord, "vault" | "once">): void } {
  return {
    update(record) {
      deps.once.replace(record.once);
      deps.source.setVault(record.vault);
      deps.source.setOnce(deps.once.entries());
      deps.environment?.setVault(record.vault);
    },
  };
}

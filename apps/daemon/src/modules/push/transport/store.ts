import { PapError, PUSH_LIMITS, type PushDeviceView, type PushSubscriptionInput } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { newId } from "../../../kernel/ids.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { hashOf, shortHash } from "../endpoint-tag.ts";
import type { SubscriptionsPort, SubscriptionTarget } from "../service.ts";
import { endpointRefusal, type HostRule } from "./endpoint.ts";
import { authSecretOf, validPublicPoint } from "./point.ts";

export type ListItem = PushDeviceView;

export interface Subscriptions extends SubscriptionsPort {
  /** Throws PapError bad_request | capacity | conflict | push_unavailable (no key). A re-add of a stored endpoint refreshes the row. */
  add(owner: string, credentialId: string, input: PushSubscriptionInput): { id: string };
  list(owner: string, credentialId: string): ListItem[];
  revoke(owner: string, id: string): boolean;
  markOk(id: string, at: number): void;
  /** Boot, after `loadVapid`: rows made under another key can never be decrypted by this one. */
  purgeForeignKeys(keyId: string): number;
  countFor(owner: string): number;
  /** The row's endpoint hash (`h:` + 12 hex) and host, for the audit; null when the owner has no such row. */
  /** The owner revoked this endpoint (W6-R15): checked before the subscribe window is spent. */
  revoked(owner: string, endpoint: string): boolean;
  describe(owner: string, id: string): { endpoint: string; host: string } | null;
}

export interface SubscriptionStoreOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The current VAPID key id; null while push has no key (nothing can be stored). */
  readonly keyId: string | null;
  readonly hosts: readonly HostRule[];
  readonly loopbackForTests: boolean;
}

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  credential_id: string;
  locale: "en" | "fr";
  label: string;
  created_at: number;
  last_ok_at: number | null;
}

// Controls, format characters (bidi, zero-width) and line or paragraph separators: never shown, never stored.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;
/** How many revoked endpoints an owner keeps a mark of. */
const REVOKED_MARKS = 50;
const COLUMNS = "id, endpoint, p256dh, auth, credential_id, locale, label, created_at, last_ok_at";

function cleanLabel(label: string): string {
  const clean = [...label.replace(HIDDEN, "").trim()].slice(0, PUSH_LIMITS.labelMax).join("").trim();
  return clean === "" ? "Device" : clean;
}

const hostOf = (href: string): string => {
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
};

export function createSubscriptionStore(db: Db, options: SubscriptionStoreOptions): Subscriptions {
  const { clock, logger, keyId } = options;
  const refused = (reason: string): never => {
    logger.warn("push_subscribe_refused", { reason }); // a reason class, never the endpoint text
    throw new PapError("bad_request");
  };
  return {
    add(owner, credentialId, input) {
      if (keyId === null) throw new PapError("push_unavailable");
      const check = endpointRefusal(input.endpoint, {
        hosts: options.hosts,
        loopbackForTests: options.loopbackForTests,
      });
      if (!check.ok) return refused(check.reason);
      if (!validPublicPoint(input.keys.p256dh)) return refused("p256dh");
      if (authSecretOf(input.keys.auth) === null) return refused("auth");
      const hash = hashOf(check.href);
      const label = cleanLabel(input.label);
      return db.transaction(() => {
        // A revoked endpoint is not re-enrolled by a refresh (W6-R15); the device drops it and Enable makes a new one.
        if (
          db.get("SELECT 1 FROM push_revoked WHERE owner_id = $owner AND endpoint_hash = $hash", {
            owner,
            hash,
          }) !== undefined
        )
          throw new PapError("push_revoked");
        const mine = db.get<{ id: string }>(
          "SELECT id FROM push_subs WHERE owner_id = $owner AND endpoint_hash = $hash",
          { owner, hash },
        );
        if (mine === undefined) {
          const taken = db.get("SELECT 1 FROM push_subs WHERE endpoint_hash = $hash", { hash });
          if (taken !== undefined) throw new PapError("conflict");
          const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subs WHERE owner_id = $owner", {
            owner,
          });
          if ((count?.n ?? 0) >= PUSH_LIMITS.subscriptionsPerOwner) throw new PapError("capacity");
        }
        const id = mine?.id ?? newId();
        if (mine === undefined)
          db.run(
            "INSERT INTO push_subs (id, owner_id, credential_id, key_id, endpoint, endpoint_hash, p256dh, auth, locale, label, created_at) VALUES ($id, $owner, $credentialId, $keyId, $endpoint, $hash, $p256dh, $auth, $locale, $label, $now)",
            {
              id,
              owner,
              credentialId,
              keyId,
              endpoint: check.href,
              hash,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              locale: input.locale,
              label,
              now: clock.now(),
            },
          );
        else
          // A re-login re-binds the device to its new credential (M12R12); a new key set and label replace the old ones.
          db.run(
            "UPDATE push_subs SET credential_id = $credentialId, key_id = $keyId, p256dh = $p256dh, auth = $auth, locale = $locale, label = $label WHERE id = $id",
            {
              id,
              credentialId,
              keyId,
              p256dh: input.keys.p256dh,
              auth: input.keys.auth,
              locale: input.locale,
              label,
            },
          );
        db.run("DELETE FROM push_meta WHERE key = 'keys_reset'");
        return { id };
      });
    },
    revoked(owner, endpoint) {
      const check = endpointRefusal(endpoint, {
        hosts: options.hosts,
        loopbackForTests: options.loopbackForTests,
      });
      return (
        check.ok &&
        db.get("SELECT 1 FROM push_revoked WHERE owner_id = $owner AND endpoint_hash = $hash", {
          owner,
          hash: hashOf(check.href),
        }) !== undefined
      );
    },
    list: (owner, credentialId) =>
      db
        .all<Row>(`SELECT ${COLUMNS} FROM push_subs WHERE owner_id = $owner ORDER BY created_at, rowid`, {
          owner,
        })
        .map((row) => ({
          id: row.id,
          label: row.label,
          host: hostOf(row.endpoint),
          createdAt: row.created_at,
          lastOkAt: row.last_ok_at,
          current: row.credential_id === credentialId,
        })),
    revoke: (owner, id) =>
      db.transaction(() => {
        const row = db.get<{ endpoint_hash: string }>(
          "SELECT endpoint_hash FROM push_subs WHERE owner_id = $owner AND id = $id",
          { owner, id },
        );
        if (row === undefined) return false;
        db.run("DELETE FROM push_subs WHERE id = $id", { id });
        db.run(
          "INSERT OR REPLACE INTO push_revoked (owner_id, endpoint_hash, revoked_at) VALUES ($owner, $hash, $now)",
          { owner, hash: row.endpoint_hash, now: clock.now() },
        );
        // bounded: the newest REVOKED_MARKS per owner stay
        db.run(
          `DELETE FROM push_revoked WHERE owner_id = $owner AND endpoint_hash NOT IN (
             SELECT endpoint_hash FROM push_revoked WHERE owner_id = $owner ORDER BY revoked_at DESC, rowid DESC LIMIT ${REVOKED_MARKS})`,
          { owner },
        );
        return true;
      }),
    describe(owner, id) {
      const row = db.get<{ endpoint: string; endpoint_hash: string }>(
        "SELECT endpoint, endpoint_hash FROM push_subs WHERE owner_id = $owner AND id = $id",
        { owner, id },
      );
      return row === undefined
        ? null
        : { endpoint: shortHash(row.endpoint_hash), host: hostOf(row.endpoint) };
    },
    targets(owner, credentialId) {
      const rows =
        credentialId === undefined
          ? db.all<Row>(
              `SELECT ${COLUMNS} FROM push_subs WHERE owner_id = $owner ORDER BY created_at, rowid`,
              { owner },
            )
          : db.all<Row>(
              `SELECT ${COLUMNS} FROM push_subs WHERE owner_id = $owner AND credential_id = $credentialId ORDER BY created_at, rowid`,
              { owner, credentialId },
            );
      return rows.map((row): SubscriptionTarget => ({
        id: row.id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        credentialId: row.credential_id,
        locale: row.locale,
      }));
    },
    drop(id, why) {
      const row = db.get<{ endpoint_hash: string }>("SELECT endpoint_hash FROM push_subs WHERE id = $id", {
        id,
      });
      if (row === undefined) return;
      db.run("DELETE FROM push_subs WHERE id = $id", { id });
      logger.info("push_subscription_dropped", { why, endpoint: shortHash(row.endpoint_hash) });
    },
    markOk: (id, at) => void db.run("UPDATE push_subs SET last_ok_at = $at WHERE id = $id", { id, at }),
    purgeForeignKeys: (current) =>
      db.run("DELETE FROM push_subs WHERE key_id <> $current", { current }).changes,
    countFor: (owner) =>
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subs WHERE owner_id = $owner", { owner })?.n ?? 0,
  };
}

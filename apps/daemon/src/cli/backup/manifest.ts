import { z } from "zod";

/** `schema_migrations` ids look like `kernel/202610100000_init.sql` or `<module>/<stamp>_<name>.sql`. */
const MIGRATION_ID = /^[a-z0-9_-]{1,40}\/\d{12}_[a-z0-9_]{1,80}\.sql$/;

/** The first member of every backup. Strict: an unknown key means a newer format and is refused, never ignored. */
export const ManifestSchema = z
  .strictObject({
    format: z.literal(1),
    /** Printed in the restore summary: letters, digits and `.+-` only, so a manifest cannot put escapes on the terminal. */
    papVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
    createdAt: z.string().datetime(),
    /** Migration ids `state.db` held when the snapshot was taken. */
    schema: z.array(z.string().regex(MIGRATION_ID)).max(5000),
    stateDb: z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().nonnegative(),
    }),
    /** `included` only in an encrypted backup. */
    secrets: z.enum(["excluded", "included"]),
    /** Top-level names present besides `manifest.json` and `state.db`. */
    tops: z.array(z.enum(["attachments", "agents", "exports", "secrets", "pi-agent"])).max(5),
    skipped: z.strictObject({
      links: z.number().int().nonnegative(),
      names: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
    }),
  })
  .superRefine((manifest, context) => {
    if ((manifest.secrets === "included") !== manifest.tops.includes("secrets"))
      context.addIssue({ code: "custom", message: "secrets and the tops list disagree", path: ["secrets"] });
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/** `secrets/` goes in only when the backup is encrypted AND the owner asked; one function so no caller can forget the rule. */
export function secretsAllowed(options: { secrets: "exclude" | "include"; encrypt: boolean }): boolean {
  return options.secrets === "include" && options.encrypt;
}

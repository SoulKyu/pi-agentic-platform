import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareHome } from "../../kernel/home.ts";
import { createBackup } from "../backup/create.ts";
import { encryptStream } from "../backup/crypto.ts";
import { schemaIds } from "../ops/snapshot.ts";
import { knownMigrationIds } from "../ops/schema-status.ts";
import { gnuTar } from "./tar-fixtures.ts";

export const PASSPHRASE = "correct horse battery";
export const NOW = new Date(Date.UTC(2026, 9, 17, 12));

/** A small database that carries the migration ids of this build (or the given ones) and rows in `t`. */
export function makeDb(
  path: string,
  rows: readonly string[],
  ids: readonly string[] = [...knownMigrationIds()],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  for (const id of ids) db.prepare("INSERT INTO schema_migrations VALUES (?)").run(id);
  db.exec("CREATE TABLE t (v TEXT)");
  for (const row of rows) db.prepare("INSERT INTO t VALUES (?)").run(row);
  db.close();
}

export function readRows(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT v FROM t ORDER BY v").all() as { v: string }[]).map((row) => row.v);
  } finally {
    db.close();
  }
}

/** A home like the daemon leaves it: private folders, `update/` and `tmp/` present, a database and the given files. */
export function makeHome(home: string, rows: readonly string[], files: Record<string, string> = {}): void {
  prepareHome(home);
  mkdirSync(join(home, "update"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
  makeDb(join(home, "state.db"), rows);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home, name)), { recursive: true });
    writeFileSync(join(home, name), content);
  }
}

/** A real backup of `home` (the production code), plain or encrypted. */
export async function backupOf(
  home: string,
  piDir: string,
  outDir: string,
  options: { encrypt?: boolean; secrets?: "exclude" | "include" } = {},
): Promise<string> {
  const result = await createBackup({
    home,
    piDir,
    outDir,
    now: NOW,
    papVersion: "0.0.0",
    secrets: options.secrets ?? "exclude",
    skip: new Set(),
    allowLarge: false,
    ...(options.encrypt === true ? { encrypt: (plain, out) => encryptStream(plain, out, PASSPHRASE) } : {}),
  });
  return result.path;
}

/** Every entry under `root` as `path -> type mode size sha`: two equal maps mean a byte-identical tree. */
export function treeOf(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (path: string, name: string): void => {
    const stat = lstatSync(path);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isDirectory()) {
      found.set(name, `dir ${mode}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
    } else if (stat.isFile()) {
      found.set(name, `file ${mode} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    } else {
      found.set(name, `other ${mode}`);
    }
  };
  visit(root, ".");
  return found;
}

export interface Craft {
  /** Files below the archive root (`manifest.json` and `state.db` are made for you). */
  readonly files?: Record<string, string>;
  /** Symbolic links: member name -> target. */
  readonly links?: Record<string, string>;
  /** A database file to archive as `state.db`. */
  readonly db?: string;
  /** Replaces keys of the manifest (a string replaces the whole file). */
  readonly manifest?: Record<string, unknown> | string;
  readonly extra?: readonly string[];
}

const TOPS = ["attachments", "agents", "exports", "secrets", "pi-agent"];

/** An archive written with the flags `pap backup` uses, for tests that need a manifest or a member a real backup never has. */
export function craft(root: string, name: string, spec: Craft = {}): string {
  const work = join(root, `work-${name}`);
  mkdirSync(work, { recursive: true });
  const dbFile = join(work, "state.db");
  if (spec.db === undefined) makeDb(dbFile, ["crafted"]);
  else copyFileSync(spec.db, dbFile);
  const files = spec.files ?? {};
  const names = new Set<string>();
  const addWithParents = (member: string): void => {
    const parts = member.split("/");
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("/"));
  };
  for (const [member, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, member)), { recursive: true });
    writeFileSync(join(work, member), content);
    addWithParents(member);
  }
  for (const [member, target] of Object.entries(spec.links ?? {})) {
    mkdirSync(dirname(join(work, member)), { recursive: true });
    symlinkSync(target, join(work, member));
    addWithParents(member);
  }
  const tops = TOPS.filter((top) => [...names].some((entry) => entry === top || entry.startsWith(`${top}/`)));
  const manifest =
    typeof spec.manifest === "string"
      ? spec.manifest
      : JSON.stringify({
          format: 1,
          papVersion: "0.0.0",
          createdAt: NOW.toISOString(),
          schema: schemaIds(dbFile),
          stateDb: {
            sha256: createHash("sha256").update(readFileSync(dbFile)).digest("hex"),
            bytes: lstatSync(dbFile).size,
          },
          secrets: tops.includes("secrets") ? "included" : "excluded",
          tops,
          skipped: { links: 0, names: 0, changed: 0 },
          ...spec.manifest,
        });
  writeFileSync(join(work, "manifest.json"), manifest);
  const archive = join(root, `${name}.tar.gz`);
  const dirs = [...names].sort();
  gnuTar(work, archive, ["manifest.json", "state.db", ...dirs], spec.extra);
  return archive;
}

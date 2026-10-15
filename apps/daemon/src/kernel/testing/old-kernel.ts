import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_MIGRATIONS, type MigrationSource } from "../db/migrate.ts";

/**
 * The kernel migrations a home had before the outbox (M10): for the tests that build an older home and migrate it
 * forward. Other migrations stamped earlier than the outbox are refused after it, so an "old" home must not hold it.
 */
export function kernelBeforeOutbox(parent: string): MigrationSource {
  const dir = join(parent, "kernel-before-outbox");
  mkdirSync(dir);
  copyFileSync(join(KERNEL_MIGRATIONS.dir, "202610100000_kernel.sql"), join(dir, "202610100000_kernel.sql"));
  return { module: KERNEL_MIGRATIONS.module, dir };
}

/** The stamp of M10's first migration (the outbox): a home migrated before it is a home M9 left. */
export const FIRST_M10_STAMP = "202610142000";

/**
 * The sources of a home as M9 left it: each source keeps only the migrations stamped before the outbox. A later run
 * with the real sources applies M10's migrations on top, as the preview's `state.db` does at the first boot after M10.
 */
export function sourcesBeforeM10(parent: string, sources: readonly MigrationSource[]): MigrationSource[] {
  const kept: MigrationSource[] = [];
  sources.forEach((source, index) => {
    const files = readdirSync(source.dir).filter(
      (file) => file.endsWith(".sql") && file.slice(0, 12) < FIRST_M10_STAMP,
    );
    if (files.length === 0) return;
    const dir = join(parent, `before-m10-${String(index)}-${source.module}`);
    mkdirSync(dir);
    for (const file of files) copyFileSync(join(source.dir, file), join(dir, file));
    kept.push({ module: source.module, dir });
  });
  return kept;
}

// The English catalog of the web app, for journeys: `t(key)` is the text a person reads, so a locator follows a copy
// change instead of a typed string (M13R4). apps/web/src/i18n/{en,fr}.ts read `import.meta.env.DEV`, which is undefined
// under Playwright's Node loader, and spread only four of the catalogs (the rest register lazily): the files are copied
// to a temporary directory with the literal rewritten to `false` and dumped to JSON by a child Node process (M13R37).
// No `@pap/*` import (Playwright's loader lacks the `development` condition) and no change to the web app.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const I18N = fileURLToPath(new URL("../../apps/web/src/i18n", import.meta.url));
const DUMP = fileURLToPath(new URL("./catalog-dump.ts", import.meta.url));

type Entries = Readonly<Record<string, string>>;
export interface Catalogs {
  readonly en: Entries;
  readonly fr: Entries;
}

function build(): Catalogs {
  const tmp = mkdtempSync(join(tmpdir(), "pap-e2e-i18n-"));
  try {
    writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
    cpSync(join(I18N, "catalog"), join(tmp, "catalog"), {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
    for (const file of ["en.ts", "fr.ts"]) {
      const text = readFileSync(join(I18N, file), "utf8");
      writeFileSync(join(tmp, file), text.replaceAll("import.meta.env.DEV", "false"));
    }
    for (const file of readdirSync(join(tmp, "catalog"))) {
      const path = join(tmp, "catalog", file);
      const text = readFileSync(path, "utf8");
      if (text.includes("import.meta.env.DEV"))
        writeFileSync(path, text.replaceAll("import.meta.env.DEV", "false"));
    }
    const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", DUMP, tmp], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out) as Catalogs;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

let cache: Catalogs | undefined;
export const catalogs = (): Catalogs => (cache ??= build());

type Vars = Record<string, string | number>;

// The same six lines as `translateIn` in apps/web/src/i18n/index.ts (a missing key throws here instead of showing the key).
function translateIn(catalog: Entries, key: string, vars: Vars = {}): string {
  const message = catalog[key];
  if (message === undefined) throw new Error(`the English catalog has no key "${key}"`);
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export const t = (key: string, vars?: Vars): string => translateIn(catalogs().en, key, vars);

/** As `plural` in apps/web/src/i18n/index.ts: `<base>.one` / `<base>.other` by `Intl.PluralRules("en")`, `.other` when a form is missing. */
export function plural(base: string, count: number, vars: Vars = {}): string {
  const form = new Intl.PluralRules("en").select(count);
  const key = `${base}.${form}`;
  const known = Object.hasOwn(catalogs().en, key);
  return translateIn(catalogs().en, known ? key : `${base}.other`, { ...vars, count });
}

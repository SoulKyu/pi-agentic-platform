// Child process of catalog.ts: imports the rewritten copy of apps/web/src/i18n in the directory given as argument and
// prints `{en, fr}` as JSON. en.ts and fr.ts hold only four of the catalogs; the rest register lazily in the web app, so
// every `*En` / `*Fr` export of catalog/*.ts is merged here. catalog/dev.ts stays out: en.ts drops it when DEV is false.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Entries = Record<string, string>;
const dir = process.argv[2];
if (!dir) throw new Error("usage: catalog-dump.ts <directory with the copied i18n files>");

const load = async (file: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;

const merged: Record<"en" | "fr", Entries> = { en: {}, fr: {} };
const take = (language: "en" | "fr", exports: Record<string, unknown>, suffix: "En" | "Fr"): void => {
  for (const [name, value] of Object.entries(exports)) {
    if (name.endsWith(suffix) && typeof value === "object" && value !== null) {
      Object.assign(merged[language], value);
    }
  }
};

const eager = { en: await load("en.ts"), fr: await load("fr.ts") };
Object.assign(merged.en, eager.en["en"]);
Object.assign(merged.fr, eager.fr["fr"]);
for (const file of readdirSync(join(dir, "catalog")).sort()) {
  if (!file.endsWith(".ts") || file === "dev.ts") continue;
  const exports = await load(`catalog/${file}`);
  take("en", exports, "En");
  take("fr", exports, "Fr");
}
process.stdout.write(JSON.stringify(merged));

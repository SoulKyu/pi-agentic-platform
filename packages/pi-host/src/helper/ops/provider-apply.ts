import { credentialName, MODELS_LIMITS, NO_KEY_LITERAL, type ProviderInput } from "@pap/contracts/pi-host";
import { stripBom } from "../jsonc.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const STRINGS = /"(?:[^"\\\n]|\\.)*"/g;

export type Applied =
  | { readonly text: string }
  | { readonly issues: readonly string[] }
  | { readonly fail: "conflict" | "not_found" };

/** Strict JSON only (MPR11): a comment or a trailing comma would be dropped by a rewrite, and an integer of 16 or more digits would lose precision. */
export function parseStrict(text: string): Json | null {
  const clean = stripBom(text);
  if (/\d{16,}/.test(clean.replace(STRINGS, '""'))) return null;
  try {
    // A number that does not fit a double (`1e400`) would be written back as null: refuse it like a long integer.
    const value: unknown = JSON.parse(clean, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new RangeError("non-finite");
      return item;
    });
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const OWNED_MODEL_FIELDS = ["name", "reasoning", "input", "contextWindow", "maxTokens"] as const;
const envRef = (name: string): string => `$${name}`;

export function applyProvider(
  current: string | null,
  input: ProviderInput,
  mode: "create" | "update",
  builtin: ReadonlySet<string>,
): Applied {
  if (builtin.has(input.id)) return { issues: ["$.provider.id"] };
  let root: Json = { providers: {} };
  if (current !== null) {
    const parsed = parseStrict(current);
    if (parsed === null) return { issues: ["$.file"] }; // needs_raw_editor: the caller words it
    root = parsed;
  }
  if (root.providers === undefined) root.providers = {};
  const providers = root.providers;
  if (!isObject(providers)) return { issues: ["$.file"] }; // a non-object `providers` is the raw editor's
  const existing = Object.hasOwn(providers, input.id) ? providers[input.id] : undefined;
  // The caller checked the revision first, so the file is the one the form read: the id is simply taken.
  if (mode === "create" && existing !== undefined) return { issues: ["$.provider.id"] };
  if (mode === "update" && !isObject(existing)) return { fail: "not_found" };
  if (mode === "create" && Object.keys(providers).length >= MODELS_LIMITS.providers)
    return { issues: ["$.providers"] };

  const entry: Json = isObject(existing) ? { ...existing } : {};
  const issues: string[] = [];

  if (input.name === undefined) delete entry.name;
  else entry.name = input.name;
  entry.api = input.api;
  entry.baseUrl = input.baseUrl;

  switch (input.auth.kind) {
    case "stored":
      delete entry.apiKey;
      break;
    case "env":
      entry.apiKey = envRef(input.auth.name);
      break;
    case "none":
      entry.apiKey = NO_KEY_LITERAL;
      break;
    case "keep":
      break;
  }

  const old = isObject(entry.headers) ? entry.headers : {};
  const headers: Record<string, string> = {};
  input.headers.forEach((header, index) => {
    const at = `$.provider.headers[${index}]`;
    switch (header.value.kind) {
      case "literal":
        // The schema guards too; the op guards independently (a `$` is interpolated by Pi, a `!` is a command).
        if (
          credentialName(header.name) ||
          header.value.text.includes("$") ||
          header.value.text.startsWith("!")
        )
          issues.push(at);
        else headers[header.name] = header.value.text;
        break;
      case "env":
        headers[header.name] = envRef(header.value.name);
        break;
      case "keep": {
        const prior = Object.hasOwn(old, header.name) ? old[header.name] : undefined;
        if (typeof prior === "string") headers[header.name] = prior;
        else issues.push(at);
        break;
      }
    }
  });
  if (input.headers.length === 0) delete entry.headers;
  else entry.headers = headers;

  const oldModels = new Map<string, Json>();
  if (Array.isArray(entry.models))
    for (const model of entry.models)
      if (isObject(model) && typeof model.id === "string") oldModels.set(model.id, model);
  const models = input.models.map((model) => {
    const merged: Json = { ...(oldModels.get(model.id) ?? {}), id: model.id };
    for (const key of OWNED_MODEL_FIELDS) {
      if (model[key] === undefined) Reflect.deleteProperty(merged, key);
      else merged[key] = model[key];
    }
    return merged;
  });
  if (models.length === 0) delete entry.models;
  else entry.models = models;

  if (issues.length > 0) return { issues };
  providers[input.id] = entry;
  return { text: `${JSON.stringify(root, null, 2)}\n` };
}

/** Removes `providers[id]` only; every other byte of meaning stays. */
export function removeProvider(current: string, id: string, builtin: ReadonlySet<string>): Applied {
  if (builtin.has(id)) return { issues: ["$.provider.id"] };
  const root = parseStrict(current);
  if (root === null) return { issues: ["$.file"] };
  const providers = root.providers;
  if (providers !== undefined && !isObject(providers)) return { issues: ["$.file"] };
  if (providers === undefined || !Object.hasOwn(providers, id)) return { fail: "not_found" };
  Reflect.deleteProperty(providers, id);
  return { text: `${JSON.stringify(root, null, 2)}\n` };
}

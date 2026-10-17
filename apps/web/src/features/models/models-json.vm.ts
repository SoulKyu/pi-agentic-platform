import type { PricingEntry, ProviderView } from "@pap/contracts";
import { type MessageKey, t } from "../../i18n/index.ts";

/**
 * Small, text-preserving edits of a `models.json` draft (JSONC): a token scan finds the place, the text around it is
 * copied as it is, so comments and layout stay. Nothing here parses values beyond string keys.
 */

interface Token {
  readonly kind: "{" | "}" | "[" | "]" | "," | ":" | "string" | "literal";
  readonly start: number;
  readonly end: number;
}

const PUNCTUATION = new Set(["{", "}", "[", "]", ",", ":"]);

function scan(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (/\s/.test(ch)) i += 1;
    else if (ch === "/" && next === "/") {
      const stop = text.indexOf("\n", i);
      i = stop === -1 ? text.length : stop;
    } else if (ch === "/" && next === "*") {
      const stop = text.indexOf("*/", i + 2);
      if (stop === -1) return null;
      i = stop + 2;
    } else if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: ch as Token["kind"], start: i, end: i + 1 });
      i += 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      tokens.push({ kind: "string", start: i, end: j + 1 });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s"/{}[\],:]/.test(text.charAt(j))) j += 1;
      if (j === i) return null;
      tokens.push({ kind: "literal", start: i, end: j });
      i = j;
    }
  }
  return tokens;
}

/** A parsed view over the tokens: indexes into `tokens`. */
class Cursor {
  readonly text: string;
  readonly tokens: readonly Token[];

  constructor(text: string, tokens: readonly Token[]) {
    this.text = text;
    this.tokens = tokens;
  }

  /** The index after the value that starts at `at`, or -1 when the tokens end inside it. */
  after(at: number): number {
    const open = this.tokens[at]?.kind;
    if (open === undefined) return -1;
    if (open !== "{" && open !== "[") return at + 1;
    let depth = 0;
    for (let i = at; i < this.tokens.length; i += 1) {
      const kind = this.tokens[i]?.kind;
      if (kind === "{" || kind === "[") depth += 1;
      if (kind === "}" || kind === "]") depth -= 1;
      if (depth === 0) return i + 1;
    }
    return -1;
  }

  key(at: number): string | null {
    const token = this.tokens[at];
    if (token?.kind !== "string") return null;
    try {
      const value: unknown = JSON.parse(this.text.slice(token.start, token.end));
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /** The members of the object at `at`: key and the index of the value. Null when it is not a well-formed object. */
  members(at: number): Array<{ key: string; value: number; keyAt: number }> | null {
    if (this.tokens[at]?.kind !== "{") return null;
    const end = this.after(at);
    if (end === -1) return null;
    const out: Array<{ key: string; value: number; keyAt: number }> = [];
    let i = at + 1;
    while (i < end - 1) {
      const key = this.key(i);
      if (key === null || this.tokens[i + 1]?.kind !== ":") return null;
      out.push({ key, value: i + 2, keyAt: i });
      i = this.after(i + 2);
      if (i === -1) return null;
      if (this.tokens[i]?.kind === ",") i += 1;
    }
    return out;
  }

  /** The indexes of the elements of the array at `at`. */
  elements(at: number): number[] | null {
    if (this.tokens[at]?.kind !== "[") return null;
    const end = this.after(at);
    if (end === -1) return null;
    const out: number[] = [];
    let i = at + 1;
    while (i < end - 1) {
      out.push(i);
      i = this.after(i);
      if (i === -1) return null;
      if (this.tokens[i]?.kind === ",") i += 1;
    }
    return out;
  }

  member(at: number, key: string): number | null {
    return this.members(at)?.find((one) => one.key === key)?.value ?? null;
  }

  /**
   * Puts `items` as new members or elements before the closing token of the object or array at `at`, keeping the
   * layout: one item per line, indented two spaces deeper than the closing token's line.
   */
  append(at: number, items: readonly string[]): string {
    const close = this.after(at) - 1;
    const closeToken = this.tokens[close] as Token;
    const lineStart = this.text.lastIndexOf("\n", closeToken.start - 1) + 1;
    const lead = this.text.slice(lineStart, closeToken.start);
    const indent = /^\s*$/.test(lead) ? lead : (/^\s*/.exec(lead)?.[0] ?? "");
    const pad = `\n${indent}  `;
    const last = this.tokens[close - 1];
    if (last === undefined || close === at + 1) {
      const body = `${pad}${items.join(`,${pad}`)}\n${indent}`;
      return this.text.slice(0, (this.tokens[at] as Token).end) + body + this.text.slice(closeToken.start);
    }
    if (last.kind === ",") {
      return this.text.slice(0, last.end) + pad + items.join(`,${pad}`) + "," + this.text.slice(last.end);
    }
    return this.text.slice(0, last.end) + "," + pad + items.join(`,${pad}`) + this.text.slice(last.end);
  }
}

function cursorOf(text: string): Cursor | null {
  const tokens = scan(text);
  if (tokens === null || tokens.length === 0) return null;
  const cursor = new Cursor(text, tokens);
  return cursor.after(0) === tokens.length && tokens[0]?.kind === "{" ? cursor : null;
}

export interface DiscoveredEntry {
  readonly id: string;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoning?: boolean | undefined;
}

export interface InsertResult {
  readonly text: string;
  readonly added: number;
  readonly skipped: number;
}

const entryJson = (entry: DiscoveredEntry): string =>
  JSON.stringify({
    id: entry.id,
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
  });

const modelsMember = (items: readonly string[]): string => `"models": [${items.join(", ")}]`;

/**
 * Adds discovered models to a provider's `models` array in the draft (creating the array, the provider or the
 * `providers` object when they are missing). Ids already in the array are skipped. `null`: the draft is not an object
 * this can place the models in; the text is then left as it is.
 */
export function insertModels(
  text: string,
  providerId: string,
  models: readonly DiscoveredEntry[],
): InsertResult | null {
  const fresh = (items: readonly string[]) =>
    `{\n  "providers": {\n    ${JSON.stringify(providerId)}: {\n      "models": [\n        ${items.join(",\n        ")}\n      ]\n    }\n  }\n}\n`;
  const items = models.map(entryJson);
  if (text.trim() === "") return { text: fresh(items), added: models.length, skipped: 0 };
  const cursor = cursorOf(text);
  if (cursor === null) return null;
  const providers = cursor.member(0, "providers");
  if (providers === null) {
    return {
      text: cursor.append(0, [
        `"providers": {\n    ${JSON.stringify(providerId)}: { ${modelsMember(items)} }\n  }`,
      ]),
      added: models.length,
      skipped: 0,
    };
  }
  if (cursor.members(providers) === null) return null;
  const provider = cursor.member(providers, providerId);
  if (provider === null) {
    return {
      text: cursor.append(providers, [`${JSON.stringify(providerId)}: { ${modelsMember(items)} }`]),
      added: models.length,
      skipped: 0,
    };
  }
  if (cursor.members(provider) === null) return null;
  const array = cursor.member(provider, "models");
  if (array === null) {
    return { text: cursor.append(provider, [modelsMember(items)]), added: models.length, skipped: 0 };
  }
  const elements = cursor.elements(array);
  if (elements === null) return null;
  const present = new Set<string>();
  for (const element of elements) {
    const id = cursor.member(element, "id");
    const name = id === null ? null : cursor.key(id);
    if (name !== null) present.add(name);
  }
  const wanted = models.filter((one) => !present.has(one.id));
  if (wanted.length === 0) return { text, added: 0, skipped: models.length };
  return {
    text: cursor.append(array, wanted.map(entryJson)),
    added: wanted.length,
    skipped: models.length - wanted.length,
  };
}

type Cost = Pick<PricingEntry, "input" | "output" | "cacheRead" | "cacheWrite">;

/**
 * Puts a `cost` object (every field present, missing prices 0) on the model of the draft, replacing one it has.
 * `null`: the draft has no such provider or model.
 */
export function setModelCost(text: string, providerId: string, modelId: string, cost: Cost): string | null {
  const cursor = cursorOf(text);
  if (cursor === null) return null;
  const providers = cursor.member(0, "providers");
  const provider = providers === null ? null : cursor.member(providers, providerId);
  const array = provider === null ? null : cursor.member(provider, "models");
  const elements = array === null ? null : cursor.elements(array);
  if (elements === null) return null;
  const target = elements.find((element) => {
    const id = cursor.member(element, "id");
    return id !== null && cursor.key(id) === modelId;
  });
  if (target === undefined) return null;
  const value = JSON.stringify({
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
  });
  const existing = cursor.member(target, "cost");
  if (existing === null) return cursor.append(target, [`"cost": ${value}`]);
  const from = (cursor.tokens[existing] as Token).start;
  const to = (cursor.tokens[cursor.after(existing) - 1] as Token).end;
  return text.slice(0, from) + value + text.slice(to);
}

/** The starting text of a new or wholly replaced `models.json`: it holds no placeholders. */
export const STARTER_TEXT = '{\n  "providers": {}\n}\n';

/** Discovery is a known no-op for these built-in providers (MC34 m9): the button is not offered. */
const NO_DISCOVERY = new Set(["anthropic", "google"]);
export const discoverSupported = (provider: Pick<ProviderView, "id" | "origin">): boolean =>
  !(provider.origin === "builtin" && NO_DISCOVERY.has(provider.id));

/** The fixed text of a provider status class; an unknown one gets the generic failure. */
export function providerCodeText(
  code: string | undefined,
  fallback: MessageKey = "settingsModels.test.failed",
): string {
  switch (code) {
    case "http_4xx":
      return t("settingsModels.code.http_4xx");
    case "http_5xx":
      return t("settingsModels.code.http_5xx");
    case "network":
      return t("settingsModels.code.network");
    case "timeout":
      return t("settingsModels.code.timeout");
    default:
      return t(fallback);
  }
}

/** The prices of one models.dev entry as text, only the ones it has. */
export function priceSummary(entry: PricingEntry): string {
  const parts: string[] = [];
  if (entry.input !== undefined) parts.push(t("settingsModels.pricing.input", { value: entry.input }));
  if (entry.output !== undefined) parts.push(t("settingsModels.pricing.output", { value: entry.output }));
  if (entry.cacheRead !== undefined)
    parts.push(t("settingsModels.pricing.cacheRead", { value: entry.cacheRead }));
  if (entry.cacheWrite !== undefined)
    parts.push(t("settingsModels.pricing.cacheWrite", { value: entry.cacheWrite }));
  return `${parts.join(", ")} (${t("settingsModels.pricing.unit")})`;
}

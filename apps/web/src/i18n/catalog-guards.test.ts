import { describe, expect, it } from "vitest";
import { CODE_COPY_KEYS } from "./code-copy.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { registerCatalog, translate } from "./index.ts";

type Entries = Readonly<Record<string, string>>;
const modules = import.meta.glob<Record<string, unknown>>(["./catalog/*.ts", "!./catalog/*.test.ts"], {
  eager: true,
});

function collect(suffix: "En" | "Fr", own: Entries): Entries {
  const merged: Record<string, string> = { ...own };
  for (const module of Object.values(modules))
    for (const [name, value] of Object.entries(module))
      if (name.endsWith(suffix) && value !== null && typeof value === "object") Object.assign(merged, value);
  return merged;
}

const EN = collect("En", en);
const FR = collect("Fr", fr);
registerCatalog({ en: EN, fr: FR });

const ACRONYMS = [
  "AA", "HMAC",
  "API", "CPU", "CSP", "DNS", "HTTP", "HTTPS", "ID", "IP", "JSON", "KVM", "MCP", "OKF", "OTLP", "PR",
  "RAM", "SSH", "TLS", "URL", "USD", "VAPID", "VM", "YAML",
]; // prettier-ignore

function shouting(value: string): boolean {
  let rest = value.replace(/\{\w+\}/g, " ");
  for (const acronym of ACRONYMS) rest = rest.replace(new RegExp(`\\b${acronym}\\b`, "g"), " ");
  return !/\p{Ll}/u.test(rest) && /\p{Lu}{2}/u.test(rest);
}

describe("catalog guards", () => {
  it("sees the catalogs", () => {
    expect(Object.keys(EN).length).toBeGreaterThan(1500);
    expect(Object.keys(FR).length).toBe(Object.keys(EN).length);
  });

  it("no French value keeps a plain or no-break space before ? ! : ; » or after « once registered", () => {
    const bad = Object.keys(FR).filter((key) =>
      /[ \u00a0][?!:;»]|«[ \u00a0]/.test(translate("fr", key as never)),
    );
    expect(bad).toEqual([]);
  });

  it("no catalog value is all capitals except acronyms", () => {
    const bad = [
      ...Object.entries(EN).map(([key, value]) => ["en", key, value]),
      ...Object.entries(FR).map(([key, value]) => ["fr", key, value]),
    ].filter(([, , value]) => shouting(value ?? ""));
    expect(bad).toEqual([]);
  });

  it("a backtick appears only in CODE_COPY_KEYS values, and each is listed with its component", () => {
    const stray = [...Object.entries(EN), ...Object.entries(FR)]
      .filter(([key, value]) => value.includes("`") && !(key in CODE_COPY_KEYS))
      .map(([key]) => key);
    expect(stray).toEqual([]);
    for (const key of Object.keys(CODE_COPY_KEYS)) {
      expect(EN[key], key).toContain("`");
      expect(FR[key], key).toContain("`");
    }
  });
});

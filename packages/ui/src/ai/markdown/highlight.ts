import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export interface CodeToken {
  readonly content: string;
  readonly color: string | null;
  readonly italic: boolean;
}

export const MAX_HIGHLIGHT_CHARS = 20_000;
const THEME = "pap-code";
const SAFE_COLOR = /^var\(--shiki-[a-z-]+\)$/;

// One module per language, loaded on first use (each is its own chunk). Aliases map to the module's own name.
const LOADERS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
} as const;
type Language = keyof typeof LOADERS;
const ALIASES: Readonly<Record<string, Language>> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
};

let highlighter: Promise<HighlighterCore> | null = null;
// Bounded by LOADERS: at most one entry per language.
const loaded = new Map<Language, Promise<void>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-", fontStyle: true })],
    langs: [],
    // The JavaScript engine: no WebAssembly, so the CSP needs no 'wasm-unsafe-eval' (R74).
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighter = null; // the next code block tries again
    throw error;
  });
  return highlighter;
}

function languageOf(lang: string): Language | null {
  const name = lang.trim().toLowerCase();
  if (Object.hasOwn(LOADERS, name)) return name as Language;
  return Object.hasOwn(ALIASES, name) ? (ALIASES[name] ?? null) : null;
}

/** Tokens per line with css-variable colours, or null when the code stays plain (unknown language, too long). */
export async function highlightCode(code: string, lang: string): Promise<CodeToken[][] | null> {
  const language = languageOf(lang);
  if (language === null || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const shiki = await core();
  let ready = loaded.get(language);
  if (!ready) {
    ready = LOADERS[language]().then((module) => shiki.loadLanguage(module.default));
    loaded.set(language, ready);
    // A failed load is forgotten so the next block tries again; this call still rejects to its caller.
    ready.catch(() => loaded.delete(language));
  }
  await ready;
  return shiki.codeToTokens(code, { lang: language, theme: THEME }).tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color !== undefined && SAFE_COLOR.test(token.color) ? token.color : null,
      // shiki's FontStyle flags: 1 is italic.
      italic: ((token.fontStyle ?? 0) & 1) === 1,
    })),
  );
}

import type { Extension } from "@codemirror/state";

/** Loads the highlighting for one language; each loader is its own chunk, fetched on first use. */
export type LanguageLoader = () => Promise<Extension>;

const stream = async (mode: Promise<Record<string, unknown>>, name: string): Promise<Extension> => {
  const { StreamLanguage } = await import("@codemirror/language");
  const found = (await mode)[name] as Parameters<typeof StreamLanguage.define>[0];
  return StreamLanguage.define(found);
};

// One function per language, so two files of a language give `languageFor` the same loader.
const javascript = (typescript: boolean, jsx: boolean): LanguageLoader => {
  return async () => (await import("@codemirror/lang-javascript")).javascript({ typescript, jsx });
};
const LOADERS = {
  js: javascript(false, false),
  jsx: javascript(false, true),
  ts: javascript(true, false),
  tsx: javascript(true, true),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  shell: () => stream(import("@codemirror/legacy-modes/mode/shell"), "shell"),
  toml: () => stream(import("@codemirror/legacy-modes/mode/toml"), "toml"),
  dockerfile: () => stream(import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile"),
  go: () => stream(import("@codemirror/legacy-modes/mode/go"), "go"),
  rust: () => stream(import("@codemirror/legacy-modes/mode/rust"), "rust"),
} satisfies Record<string, LanguageLoader>;

const BY_EXTENSION: Readonly<Record<string, LanguageLoader>> = {
  ts: LOADERS.ts,
  tsx: LOADERS.tsx,
  js: LOADERS.js,
  jsx: LOADERS.jsx,
  mjs: LOADERS.js,
  cjs: LOADERS.js,
  json: LOADERS.json,
  jsonc: LOADERS.json,
  md: LOADERS.markdown,
  mdx: LOADERS.markdown,
  py: LOADERS.python,
  css: LOADERS.css,
  scss: LOADERS.css,
  less: LOADERS.css,
  html: LOADERS.html,
  htm: LOADERS.html,
  yaml: LOADERS.yaml,
  yml: LOADERS.yaml,
  sh: LOADERS.shell,
  bash: LOADERS.shell,
  zsh: LOADERS.shell,
  toml: LOADERS.toml,
  go: LOADERS.go,
  rs: LOADERS.rust,
};

/** The loader for a file, by its name: `Dockerfile` and `Dockerfile.*` first, then the extension. Null is plain text. */
export function languageFor(path: string): LanguageLoader | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return LOADERS.dockerfile;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return Object.hasOwn(BY_EXTENSION, name.slice(dot + 1).toLowerCase())
    ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null)
    : null;
}

/** Runs a loader; a missing one or one that fails (a chunk gone after an update) is plain text, and a failure is reported once. */
export async function loadLanguage(loader: LanguageLoader | null, report: () => void): Promise<Extension> {
  if (!loader) return [];
  try {
    return await loader();
  } catch {
    report();
    return [];
  }
}

// Proves the port against the real toolchain: Tailwind 4 must generate a rule for every class
// Message.tsx uses (a token missing from tokens.css would silently produce none), and the component
// must render with the expected ARIA. Usage: node render-check.ts > render-results.json
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ts from "typescript";

const here = new URL(".", import.meta.url);
const out = new URL("./dist-render/", here);
mkdirSync(out, { recursive: true });

const source = readFileSync(new URL("./src/Message.tsx", here), "utf8");
const emitted = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(new URL("./Message.mjs", out), emitted);

execFileSync(new URL("./node_modules/.bin/tailwindcss", here).pathname, ["-i", "styles.css", "-o", "dist-render/out.css"], {
  cwd: here,
  stdio: ["ignore", "ignore", "inherit"],
});
const css = readFileSync(new URL("./out.css", out), "utf8");

const escape = (cls: string) => cls.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
const classes = new Set<string>();
for (const m of source.matchAll(/(?:className=|`)[{"`]*([^"`}]*)/g)) {
  for (const cls of (m[1] as string).split(/\s+/)) if (/^[a-z0-9:.-]+$/.test(cls) && cls.includes("-")) classes.add(cls);
}
classes.add("border-agent").add("border-human").add("border-line");
const hasRule = (cls: string) => css.includes(`.${escape(cls)}`);
const generated = [...classes].filter(hasRule);
const missing = [...classes].filter((cls) => !hasRule(cls));
const control = "bg-not-a-token";

const { Message, MessageAction, MessageActions, MessageBranch } = (await import(
  pathToFileURL(new URL("./Message.mjs", out).pathname).href
)) as typeof import("./src/Message.tsx");

const noop = () => {};
const html = {
  agent: renderToStaticMarkup(createElement(Message, { author: "agent", label: "Atlas", children: "hi" })),
  you: renderToStaticMarkup(createElement(Message, { author: "you", label: "YOU", children: "hi" })),
  withActions: renderToStaticMarkup(
    createElement(Message, {
      author: "agent",
      label: "Atlas",
      children: "hi",
      actions: createElement(MessageActions, null, createElement(MessageAction, { label: "Copy" }, "c")),
    }),
  ),
  branch: renderToStaticMarkup(
    createElement(MessageBranch, { index: 1, count: 3, previousLabel: "Previous branch", nextLabel: "Next branch", pageLabel: "2 of 3", onChange: noop }),
  ),
  singleBranch: renderToStaticMarkup(
    createElement(MessageBranch, { index: 0, count: 1, previousLabel: "p", nextLabel: "n", pageLabel: "1 of 1", onChange: noop }),
  ),
};

console.log(JSON.stringify({
  tailwind: "4.3.3",
  classesUsed: [...classes].length,
  generated: generated.length,
  missing,
  controlGenerated: hasRule(control),
  cssBytes: css.length,
  aboveSafari164InGeneratedCss: {
    nativeNesting: /^\s*&/m.test(css),
    lightDark: /light-dark\(/.test(css),
    fieldSizing: /field-sizing/.test(css),
    textBalance: /text-wrap:\s*balance/.test(css),
  },
  rendered: {
    agentRule: html.agent.includes('data-author="agent"') && html.agent.includes("border-agent"),
    youRule: html.you.includes('data-author="you"') && html.you.includes("border-human"),
    headerElement: html.agent.includes("<header "),
    actionHasScreenReaderLabel: html.withActions.includes('<span class="sr-only">Copy</span>'),
    actionIsTypeButton: html.withActions.includes('type="button"'),
    branchIsGroup: html.branch.includes('role="group"'),
    branchLabels: html.branch.includes("Previous branch") && html.branch.includes("Next branch") && html.branch.includes("2 of 3"),
    branchHiddenWhenSingle: html.singleBranch === "",
  },
}, null, 2));

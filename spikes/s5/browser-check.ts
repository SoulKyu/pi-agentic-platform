/**
 * Drives the built prototypes in headless Chromium: three comments (added, unchanged, deleted line),
 * inline placement, token fit (night to day), CSS features the library ships, runtime JS transfer and large-diff cost.
 * Needs `corepack pnpm exec vite build --mode <mode>` outputs (measure.ts builds them).
 * Env: S5_CHROMIUM (browser binary), S5_LIBS (LD_LIBRARY_PATH for a host without its shared libraries), FONTCONFIG_FILE (a host without fonts).
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium, type Page } from "playwright-core";

const CHROMIUM = process.env["S5_CHROMIUM"] ?? `${process.env["HOME"]}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

interface Candidate {
  readonly mode: string;
  /** Open the comment prompt for the line whose text contains `text`. */
  readonly openComment: (page: Page, text: string, kind: "added" | "context" | "deleted") => Promise<void>;
  /** Selector (pierced through shadow roots by Playwright) matching the first rendered line of code. */
  readonly firstLine: string;
}

const codemirror: Candidate = {
  mode: "codemirror-syntax",
  firstLine: ".cm-line",
  openComment: async (page, text, kind) => {
    const line = page.getByText(text).first();
    if (kind === "deleted") {
      await line.click(); // deleted lines have no gutter: the click lands on the line itself
      return;
    }
    const lineBox = await line.boundingBox();
    const gutterBox = await page.locator(".cm-comment-gutter").first().boundingBox();
    if (!lineBox || !gutterBox) throw new Error(`no box for ${text}`);
    await page.mouse.click(gutterBox.x + gutterBox.width / 2, lineBox.y + lineBox.height / 2);
  },
};

const pierreCandidate = (mode: string): Candidate => ({
  mode,
  firstLine: "[data-line-type]",
  openComment: async (page, text) => {
    await page.getByText(text).first().hover();
    await page.locator("button[data-utility-button]").click();
  },
});

const candidates: readonly Candidate[] = [codemirror, pierreCandidate("pierre"), pierreCandidate("pierre-worker")];

async function serve(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const file = join(dir, path === "/" ? "/index.html" : path);
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const COMMENTS = [
  { kind: "added", anchor: "var __piProjectRefresh", text: "check this addition" },
  { kind: "context", anchor: "const PROJECT_CACHE_TTL_MS", text: "unchanged but relevant" },
  { kind: "deleted", anchor: "timeout: 10_000", text: "why drop this timeout" },
] as const;

async function runPage<T>(candidate: Candidate, search: string, body: (page: Page, transfer: () => { requests: number; gzipKb: number }) => Promise<T>): Promise<T> {
  const { server, origin } = await serve(`dist-${candidate.mode}`);
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"], env: { ...process.env, LD_LIBRARY_PATH: process.env["S5_LIBS"] ?? "" } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "dark" });
    await page.addInitScript(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ entryTypes: ["longtask"] });
    });
    const transfer = jsTransfer(page);
    await page.goto(`${origin}/${search}`);
    return await body(page, transfer);
  } finally {
    await browser.close();
    server.close();
  }
}

const jsTransfer = (page: Page) => {
  const sizes: number[] = [];
  page.on("response", async (response) => {
    if (response.url().endsWith(".js")) sizes.push(gzipSync(await response.body()).length);
  });
  return () => ({ requests: sizes.length, gzipKb: Math.round(sizes.reduce((a, b) => a + b, 0) / 102.4) / 10 });
};

async function functional(candidate: Candidate) {
  return runPage(candidate, "", async (page, transfer) => {
    const prompts: string[] = [];
    const answers = COMMENTS.map((c) => c.text);
    page.on("dialog", (dialog) => void dialog.accept(answers.shift() ?? "").then(() => prompts.push(dialog.message())));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(candidate.firstLine);
    await page.waitForLoadState("networkidle");
    for (const c of COMMENTS) {
      await candidate.openComment(page, c.anchor, c.kind);
      await page.waitForTimeout(250);
    }
    const listed = await page.locator('[data-testid="comments"] li').allTextContents();
    const inline = await page.locator(".review-comment").count();
    const placement = [];
    for (const c of COMMENTS) {
      const anchor = await page.getByText(c.anchor).first().boundingBox({ timeout: 3000 }).catch(() => null);
      const note = await page.locator(".review-comment", { hasText: c.text }).first().boundingBox({ timeout: 3000 }).catch(() => null);
      placement.push({
        text: c.text,
        relativeToAnchor: !anchor || !note ? "not rendered" : note.y >= anchor.y + anchor.height - 2 ? "below the line" : note.y + note.height <= anchor.y + 2 ? "above the line" : "overlaps",
      });
    }
    const tokens = await tokenFit(page);
    const css = await cssFeatures(page);
    return { prompts, listed, inlineCommentsRendered: inline, placement, errors, runtimeJs: transfer(), tokens, css };
  });
}

/** Does the renderer follow the page's tokens? Switch night to day without touching the renderer, compare computed colours. */
async function tokenFit(page: Page) {
  const read = () =>
    page.evaluate(() => {
      const roots: ParentNode[] = [document, ...[...document.querySelectorAll("*")].flatMap((el) => (el.shadowRoot ? [el.shadowRoot] : []))];
      const q = (selector: string) => roots.flatMap((r) => [...r.querySelectorAll(selector)]);
      const colour = (el: Element | undefined, prop: "backgroundColor" | "color") => (el ? getComputedStyle(el)[prop] : "n/a");
      const added = q(".cm-changedLine, [data-content] [data-line-type='change-addition']")[0];
      const deleted = q(".cm-deletedChunk, [data-content] [data-line-type='change-deletion']")[0];
      const keyword = q("span").find((s) => s.textContent === "async");
      const surface = q(".cm-editor, pre[data-diff]")[0];
      return { addedBg: colour(added, "backgroundColor"), deletedBg: colour(deleted, "backgroundColor"), keyword: colour(keyword, "color"), surfaceBg: colour(surface, "backgroundColor") };
    });
  const night = await read();
  await page.evaluate(() => (document.documentElement.dataset["theme"] = "day"));
  await page.waitForTimeout(200);
  const day = await read();
  await page.evaluate(() => (document.documentElement.dataset["theme"] = "night"));
  const same = (a: string, b: string) => a === b;
  return { night, day, followsToken: { addedBg: !same(night.addedBg, day.addedBg), deletedBg: !same(night.deletedBg, day.deletedBg), keyword: !same(night.keyword, day.keyword), surfaceBg: !same(night.surfaceBg, day.surfaceBg) } };
}

/** The modern CSS the library injects (light DOM and shadow roots), for the Safari 16.4 floor. */
async function cssFeatures(page: Page) {
  return page.evaluate(() => {
    const found = new Map<string, { rules: number; samples: string[] }>();
    const note = (name: string, rule: CSSRule) => {
      const entry = found.get(name) ?? { rules: 0, samples: [] };
      entry.rules += 1;
      if (entry.samples.length < 3) entry.samples.push((rule instanceof CSSStyleRule ? rule.selectorText : rule.cssText).slice(0, 80));
      found.set(name, entry);
    };
    const scan = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const text = rule.cssText;
        for (const [name, re] of Object.entries({
          "light-dark()": /light-dark\(/,
          "color-mix()": /color-mix\(/,
          "lab()/oklch()": /\b(lab|lch|oklab|oklch)\(/,
          ":has()": /:has\(/,
          "@container": /^@container/,
          "@layer": /^@layer/,
          "@property": /^@property/,
          "@scope": /^@scope/,
          "@starting-style": /^@starting-style/,
          "text-wrap": /text-wrap/,
          "scrollbar-gutter": /scrollbar-gutter/,
          "scrollbar-width/color": /scrollbar-(width|color)/,
          "field-sizing": /field-sizing/,
          "anchor positioning": /anchor-name|position-anchor/,
          "content-visibility": /content-visibility/,
          "dvh/svh/lvh": /\d(dvh|svh|lvh)/,
          subgrid: /subgrid/,
          "@media prefers-color-scheme": /prefers-color-scheme/,
        })) {
          if (re.test(text)) note(name, rule);
        }
        if (rule instanceof CSSStyleRule && rule.cssRules.length > 0) note("native CSS nesting", rule);
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) scan(nested);
      }
    };
    const sheets: CSSStyleSheet[] = [...document.styleSheets];
    const walk = (root: Document | ShadowRoot) => {
      sheets.push(...root.adoptedStyleSheets);
      for (const style of root.querySelectorAll("style")) if (style.sheet) sheets.push(style.sheet);
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    for (const sheet of new Set(sheets)) {
      try {
        scan(sheet.cssRules);
      } catch {
        /* cross-origin sheet */
      }
    }
    return { features: Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b))), usesAdoptedStyleSheets: document.querySelector("*") !== null && [...document.querySelectorAll("*")].some((el) => (el.shadowRoot?.adoptedStyleSheets.length ?? 0) > 0), usesShadowDom: [...document.querySelectorAll("*")].some((el) => el.shadowRoot !== null) };
  });
}

async function scale(candidate: Candidate, lines: number) {
  return runPage(candidate, `?lines=${lines}`, async (page) => {
    const started = Date.now();
    try {
      await page.waitForSelector(candidate.firstLine, { timeout: 120_000 });
    } catch {
      return { lines, error: "no line rendered within 120 s" };
    }
    const firstLineMs = await page.evaluate(() => Math.round(performance.now()));
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      const all = (root: Document | ShadowRoot): number => [...root.querySelectorAll("*")].reduce((n, el) => n + 1 + (el.shadowRoot ? all(el.shadowRoot) : 0), 0);
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      return { domNodes: all(document), longTasks: w.__long.length, longTaskTotalMs: Math.round(w.__long.reduce((a, b) => a + b, 0)), longTaskMaxMs: Math.round(Math.max(0, ...w.__long)), heapMb: Math.round(heap / 1048576) };
    });
    return { lines, firstLineMs, wallMs: Date.now() - started, ...stats };
  });
}

const results: Record<string, unknown> = {};
for (const candidate of candidates.filter((c) => !process.env["S5_ONLY"] || c.mode === process.env["S5_ONLY"])) {
  const entry: Record<string, unknown> = { functional: await functional(candidate) };
  entry["scale"] = [await scale(candidate, 2000), await scale(candidate, 10000)];
  results[candidate.mode] = entry;
}
console.log(JSON.stringify({ chromium: await versionOf(), results }, null, 2));

async function versionOf(): Promise<string> {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"], env: { ...process.env, LD_LIBRARY_PATH: process.env["S5_LIBS"] ?? "" } });
  const version = browser.version();
  await browser.close();
  return version;
}

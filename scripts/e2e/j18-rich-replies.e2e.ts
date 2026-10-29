/// <reference lib="dom" />
// J18: rich replies and artifacts in a real browser (UX-2, UX2-R51, UX2-R85). happy-dom has no layout and Mermaid needs one,
// so the guards against model text painting over pap run here on Chromium and WebKit: the DOM under a reply, the element
// under a point (`elementFromPoint`), the `securitypolicyviolation` events of the page and the requests Playwright sees.
// The e2e daemon has no VM stack: artifacts need none. Hosts are reserved names (`example.invalid`), never a public one.
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, setupOwner, setupToken } from "./auth.ts";
import { expect, scripted, t, test } from "./fixtures.ts";

const FENCE = "```";
const PROBE = "artifact-probe";
/** A 32 by 32 grey PNG (a 1 by 1 one counts as hidden to WebKit). */
function grey(size: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.concat(
    Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size, 128)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNG = grey(32);

// The artifact tries three routes of pap's own origin and one image of another host; `{port}` is the daemon's port.
const ARTIFACT_HTML = [
  '<p id="o">artifact</p>',
  "<script>",
  "const out = document.body.dataset;",
  "const seen = [];",
  'document.addEventListener("securitypolicyviolation", (event) => { seen.push(event.effectiveDirective + " " + event.blockedURI); out.csp = JSON.stringify(seen); });',
  `fetch("http://localhost:{port}/files/raw?path=${PROBE}").then(() => { out.fetch = "reached"; }, () => { out.fetch = "blocked"; });`,
  "try {",
  `  const s = new WebSocket("ws://localhost:{port}/ws?proto=2&probe=${PROBE}");`,
  '  s.onopen = () => { out.ws = "reached"; };',
  '  s.onerror = () => { out.ws = "blocked"; };',
  '  s.onclose = () => { out.ws ??= "blocked"; };',
  '} catch { out.ws = "blocked"; }',
  `fetch("http://localhost:{port}/upload?probe=${PROBE}", { method: "POST", mode: "no-cors", body: "x" }).then(() => { out.post = "reached"; }, () => { out.post = "blocked"; });`,
  "const img = new Image();",
  'img.onload = () => { out.img = "reached"; };',
  'img.onerror = () => { out.img = "blocked"; };',
  `img.src = "http://example.invalid/${PROBE}.png";`,
  "</script>",
].join("\n");

const HOSTILE_DIAGRAM = [
  '%%{init: {"themeCSS": "svg{position:fixed;inset:0;z-index:2147483647}", "htmlLabels": true}}%%',
  "flowchart TD",
  '  A["<form><button>Allow once</button></form>"] --> B[Done]',
].join("\n");

const DIAGRAMS = [
  "flowchart LR\n  A[Start] --> B[Stop]",
  "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
  "classDiagram\n  class Animal {\n    +name\n    +eat()\n  }\n  Animal <|-- Dog",
  "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy\n  Busy --> [*]",
  "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task one :a1, 2026-01-01, 3d\n  Task two :after a1, 2d",
];

const FORMULAS = [
  String.raw`\raisebox{-15em}{\colorbox{white}{X}}`,
  String.raw`\rule{20em}{20em}`,
  String.raw`\raisebox{-15em}{x}`,
  String.raw`\def\a{-}\raisebox{\a 15em}{x}`,
  String.raw`x${String.raw`\kern-2em `.repeat(50)}y`,
  String.raw`\smash{\raisebox{2em}{\raisebox{2em}{\raisebox{2em}{x}}}}`,
];

const fenced = (lang: string, body: string): string => `${FENCE}${lang}\n${body}\n${FENCE}`;
const STEPS = [
  { text: `Here is a page:\n\n${fenced("html", ARTIFACT_HTML)}\n\nThat was it.` },
  { text: `A hostile diagram:\n\n${fenced("mermaid", HOSTILE_DIAGRAM)}\n\nAFTER-DIAGRAM` },
  {
    text: [
      "Formulas:",
      "",
      ...FORMULAS.map((tex) => `$$${tex}$$`),
      "",
      String.raw`Inline $\raisebox{-15em}{x}$ here.`,
      "",
      "AFTER-MATH text of the next message.",
    ].join("\n\n"),
  },
  { text: `Five diagrams:\n\n${DIAGRAMS.map((d) => fenced("mermaid", d)).join("\n\n")}\n\nAFTER-FIVE` },
  {
    text: "Two pictures: ![local chart](pic.png) and ![remote chart](http://example.invalid/remote.png).\n\nAFTER-PICS",
  },
];

// One session, five turns: a scripted provider serves its steps from the first one to every new session, and Playwright
// forbids a different script per describe, so the cases run in order (serial) on one page and answer one turn each.
test.describe.configure({ mode: "serial" });
test.use({ papScript: scripted(STEPS) });

let page: Page;
test.beforeAll(async ({ browser, pap }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cookie = await setupOwner(pap.origin, setupToken(pap.setupUrl), pap.owner);
  await context.addCookies([{ name: SESSION_COOKIE, value: cookie, url: pap.origin }]);
  await pap.rpc("projects.add", { root: pap.work });
  await context.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, "__violations", seen);
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page = await context.newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

const violations = (): Promise<string[]> =>
  page.evaluate(() => (Reflect.get(window, "__violations") as string[] | undefined) ?? []);
const composer = () => page.getByLabel(t("session.composer"), { exact: true });
/** The newest agent message: every case reads its own reply and nothing of the earlier turns. */
const reply = () => page.locator('article[data-slot="message"][data-author="agent"]').last();
const bodyChildren = () => page.evaluate(() => document.body.childElementCount);

async function ask(
  prompt: string,
  sentinel: string,
  first: { origin: string; work: string } | null,
): Promise<void> {
  if (first !== null) {
    await page.goto(first.origin);
    await page.getByLabel(t("launch.field"), { exact: true }).fill(prompt);
    await page.getByRole("button", { name: t("launch.go.session"), exact: true }).click();
    await page.getByRole("button", { name: basename(first.work), exact: true }).click();
  } else {
    await composer().fill(prompt);
    await page.getByRole("button", { name: t("sessions.composer.send"), exact: true }).click();
  }
  await expect(page.getByText(sentinel, { exact: true }).last()).toBeVisible();
}

/** The element at the centre of `target` is `target` or inside it. */
const owns = (target: Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });

const imageSize = (img: Locator) =>
  img.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const column = element.closest("[data-diagram]")?.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      inside: column !== undefined && rect.right <= column.right + 1,
    };
  });

test("an html artifact runs in its frame and reaches nothing", async ({ pap }) => {
  const answered: string[] = [];
  const sockets: string[] = [];
  // A request the browser starts and the CSP refuses gets no answer; "left" means it did.
  page.context().on("response", (response) => answered.push(`${response.status()} ${response.url()}`));
  page.on("websocket", (socket) => sockets.push(socket.url()));
  const before = readdirSync(pap.work);
  await ask("Show me a page", "That was it.", pap);
  const open = reply().getByRole("button", { name: t("reply.rich.preview"), exact: true });
  await open.click();

  const frame = reply().locator(`iframe[title="${t("reply.rich.artifactTitle")}"]`);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const src = await frame.getAttribute("src");
  expect(src).toContain(`:${pap.previewPort}/a/`);
  const label = reply().getByText(t("reply.rich.artifactFrame"), { exact: true });
  await expect(label).toBeVisible();
  const inside = reply()
    .frameLocator(`iframe[title="${t("reply.rich.artifactTitle")}"]`)
    .locator("body");
  await expect(inside).toHaveAttribute("data-fetch", "blocked");
  await expect(inside).toHaveAttribute("data-ws", "blocked");
  await expect(inside).toHaveAttribute("data-post", "blocked");
  await expect(inside).toHaveAttribute("data-img", "blocked");
  // Each vector the CSP can refuse produced its own violation (not a CORS, DNS or Origin refusal that would pass anyway).
  const wanted: [string, RegExp][] = [
    ["fetch", /^connect-src .*\/files\/raw\?path=artifact-probe$/u],
    ["WebSocket", /^connect-src .*\/ws\?proto=2&probe=artifact-probe$/u],
    ["POST", /^connect-src .*\/upload\?probe=artifact-probe$/u],
    ["image", /^img-src .*example\.invalid\/artifact-probe\.png$/u],
  ];
  await expect
    .poll(async () => {
      const raw = await inside.getAttribute("data-csp");
      const list = raw === null ? [] : (JSON.parse(raw) as string[]);
      return wanted.filter(([, pattern]) => !list.some((line) => pattern.test(line))).map(([name]) => name);
    })
    .toEqual([]);

  const height = await frame.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(0);
  expect(height).toBeLessThanOrEqual(900 * 0.7 + 1);
  // The label is pap's own text, outside the frame.
  expect(
    await label.evaluate((el) => el.closest("figure") !== null && el.querySelector("iframe") === null),
  ).toBe(true);

  // Outside state: nothing left the frame, and nothing changed in the project folder.
  expect(answered.filter((line) => line.includes(PROBE) || line.includes("example.invalid"))).toEqual([]);
  expect(sockets.filter((url) => url.includes(PROBE))).toEqual([]);
  expect(readdirSync(pap.work)).toEqual(before);

  // A second toggle (UX2-R55) loads the same URL.
  await reply()
    .getByRole("button", { name: t("reply.rich.hide"), exact: true })
    .click();
  await expect(frame).toHaveCount(0);
  await open.click();
  await expect(frame).toHaveAttribute("src", src ?? "");
  await reply()
    .getByRole("button", { name: t("reply.rich.hide"), exact: true })
    .click();
});

test("a mermaid fence that sets themeCSS to a fixed full-window overlay and an HTML form label draws one image and nothing over pap", async () => {
  const children = await bodyChildren();
  await ask("Draw a hostile diagram", "AFTER-DIAGRAM", null);
  const diagram = reply().locator("[data-diagram]");
  await expect(diagram.locator("img")).toHaveCount(1);
  await expect(diagram.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/u);
  expect(await diagram.locator("svg, style, form, foreignObject").count()).toBe(0);
  const hostile = await page.evaluate(() => ({
    foreign: document.querySelectorAll("foreignObject").length,
    overlay: [...document.querySelectorAll("style")].filter((el) => el.textContent?.includes("2147483647"))
      .length,
    probes: [...document.body.children].filter((el) => el.tagName === "svg" || el.id.includes("pap-diagram"))
      .length,
  }));
  expect(hostile).toEqual({ foreign: 0, overlay: 0, probes: 0 });
  expect(await bodyChildren()).toBe(children);
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  const size = await imageSize(diagram.locator("img"));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
  expect(size.inside).toBe(true);
  expect(await owns(composer())).toBe(true);
  expect(await violations()).toEqual([]);
});

test("KaTeX that tries to paint past its box stays inside it", async () => {
  await ask("Show me formulas", "AFTER-MATH text of the next message.", null);
  const math = reply().locator("[data-math]");
  await expect(math).toHaveCount(FORMULAS.length + 1);
  await expect(math.locator(".katex")).toHaveCount(FORMULAS.length + 1);
  for (const kind of ["display", "inline"] as const) {
    const contain = await reply()
      .locator(`[data-math="${kind}"]`)
      .first()
      .evaluate((el) => getComputedStyle(el).contain);
    expect(contain, kind).toContain("paint");
  }
  // After each formula, a button of the test's own: it must stay the element at its centre.
  const outcomes = await reply().evaluate((message) =>
    [...message.querySelectorAll<HTMLElement>("[data-math]")].map((formula, index) => {
      const button = document.createElement("button");
      button.textContent = `below-${index}`;
      button.style.display = "block";
      formula.after(button);
      button.scrollIntoView({ block: "center" });
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const box = formula.getBoundingClientRect();
      // Points just above and below the formula's box, across its width, hit nothing of the formula.
      const strays = [-4, box.height + 4].flatMap((dy) =>
        [0.1, 0.3, 0.5, 0.7, 0.9].map((fx) =>
          document.elementFromPoint(box.left + box.width * fx, box.top + dy),
        ),
      );
      // A paint-contained box keeps layout rects that spill (they are clipped, not moved): the oracle is the painted area. Every
      // part of a descendant's rect that lies outside the container is sampled; the element hit there must not be the formula's.
      const outer = formula.getBoundingClientRect();
      const painted = [...formula.querySelectorAll("*")].flatMap((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return [];
        const strips = [
          [r.left, r.top, r.right, Math.min(r.bottom, outer.top)],
          [r.left, Math.max(r.top, outer.bottom), r.right, r.bottom],
          [r.left, r.top, Math.min(r.right, outer.left), r.bottom],
          [Math.max(r.left, outer.right), r.top, r.right, r.bottom],
        ];
        return strips
          .filter(([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) => x1 - x0 > 1 && y1 - y0 > 1)
          .map(([x0 = 0, y0 = 0, x1 = 0, y1 = 0]) => document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2));
      });
      const escaping = painted.filter((hit) => hit !== null && formula.contains(hit)).length;
      return {
        escaping,
        button: hit === button,
        covered: strays.filter((el) => el !== null && formula.contains(el)).length,
      };
    }),
  );
  expect(outcomes.map((o) => o.escaping)).toEqual(outcomes.map(() => 0));
  expect(outcomes.map((o) => o.button)).toEqual(outcomes.map(() => true));
  expect(outcomes.map((o) => o.covered)).toEqual(outcomes.map(() => 0));
  const after = reply().getByText("AFTER-MATH text of the next message.", { exact: true });
  await after.scrollIntoViewIfNeeded();
  expect(await owns(after)).toBe(true);
  expect(await owns(composer())).toBe(true);
});

test("five diagram types draw as images with no CSP violation", async () => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  const children = await bodyChildren();
  await ask("Draw five diagrams", "AFTER-FIVE", null);
  const images = reply().locator("[data-diagram] img");
  await expect(images).toHaveCount(DIAGRAMS.length);
  for (const [index, kind] of DIAGRAMS.entries()) {
    const size = await imageSize(images.nth(index));
    expect(size.width, kind).toBeGreaterThan(0);
    expect(size.height, kind).toBeGreaterThan(0);
    expect(size.inside, kind).toBe(true);
  }
  expect(await reply().locator("[data-diagram]").locator("svg, style, form, foreignObject").count()).toBe(0);
  expect(await bodyChildren()).toBe(children);
  expect(await violations()).toEqual([]);
  expect(messages.filter((text) => /content security policy/iu.test(text))).toEqual([]);
});

test("a reply's image of the box loads from the same-origin raw route and a remote one stays text", async ({
  pap,
}) => {
  writeFileSync(join(pap.work, "pic.png"), PNG);
  const requests: string[] = [];
  page.context().on("request", (request) => requests.push(request.url()));
  await ask("Show me pictures", "AFTER-PICS", null);
  const local = reply().getByRole("img", { name: "local chart", exact: true });
  await expect(local).toBeVisible();
  await expect(local).toHaveAttribute("src", /^\/files\/raw\?path=/u);
  await expect.poll(() => local.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(reply().getByText(t("reply.rich.image", { alt: "remote chart" }))).toBeVisible();
  expect(requests.filter((url) => url.includes("example.invalid"))).toEqual([]);
  expect(readdirSync(pap.work)).toContain("pic.png");
});

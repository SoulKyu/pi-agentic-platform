/// <reference lib="dom" />
// J16: the layout the design pass promises, measured on the rendered page (happy-dom computes no layout). The longest agent
// paragraph fits a 72ch probe of the same font and a per-engine character ceiling; no page is wider than a 320 px viewport,
// with a very long project name; the first Tab lands on the skip link and Enter focuses the pane; Day's focus outline on the
// active tab reaches 3:1.
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, scripted, t, test } from "./fixtures.ts";

const SENTENCE =
  "The release notes explain which settings changed, which stayed and why the daemon restarts twice. ";
const LONG_PARAGRAPH = `Summary: ${SENTENCE.repeat(7)}`.trim();
const LONG_NAME = `a-project-folder-with-a-name-so-long-that-no-chip-or-heading-could-hold-it-on-one-line`;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 320, height: 640 };
// Characters a line may hold: 72ch over the average glyph of the font, which WebKit sets narrower (it measured 91).
const MAX_CHARACTERS = { chromium: 90, webkit: 95 } as const;
const SLACK = 0.5;
const MIN_CONTRAST = 3;

test.use({ papScript: scripted([{ text: LONG_PARAGRAPH }]) });

/** The most characters on one rendered line of `element` (every character's own client rect, grouped by its top edge),
 * the widest line's extent, and the width of a `72ch` probe inserted next to it with the same font (read-only DOM). */
const measureLines = (element: Element): { characters: number; width: number; probe: number } => {
  const perLine = new Map<number, { count: number; left: number; right: number }>();
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    for (let at = 0; at < text.length; at += 1) {
      range.setStart(text, at);
      range.setEnd(text, at + 1);
      const rect = range.getClientRects()[0];
      if (rect === undefined || rect.width === 0) continue;
      const line = Math.round(rect.top);
      const seen = perLine.get(line);
      perLine.set(line, {
        count: (seen?.count ?? 0) + 1,
        left: Math.min(seen?.left ?? rect.left, rect.left),
        right: Math.max(seen?.right ?? rect.right, rect.right),
      });
    }
  }
  const lines = [...perLine.values()];
  const probe = document.createElement("div");
  probe.style.cssText = "width:72ch;height:0;overflow:hidden;visibility:hidden";
  probe.style.font = getComputedStyle(element).font;
  element.before(probe);
  const probeWidth = probe.getBoundingClientRect().width;
  probe.remove();
  return {
    characters: Math.max(0, ...lines.map((line) => line.count)),
    width: Math.max(0, ...lines.map((line) => line.right - line.left)),
    probe: probeWidth,
  };
};

const noSidewaysScroll = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

interface Paint {
  outline: string;
  outlineWidth: number;
  background: string;
}

/** The focus outline of the focused element and the first opaque background behind it. */
const paintOf = (): Paint => {
  const focused = document.activeElement;
  if (focused === null) throw new Error("nothing has focus");
  const style = getComputedStyle(focused);
  let background = "";
  for (let node: Element | null = focused; node !== null; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (!/^rgba\(.*, 0\)$|^transparent$/.test(colour)) {
      background = colour;
      break;
    }
  }
  return { outline: style.outlineColor, outlineWidth: Number.parseFloat(style.outlineWidth), background };
};

const channels = (colour: string): number[] => {
  const numbers = colour.match(/-?\d*\.?\d+/g)?.map(Number);
  if (numbers === undefined || numbers.length < 3) throw new Error(`cannot read the colour "${colour}"`);
  return colour.startsWith("color(") ? numbers.slice(0, 3).map((value) => value * 255) : numbers.slice(0, 3);
};
const luminance = (colour: string): number => {
  const [r = 0, g = 0, b = 0] = channels(colour).map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test("J16: line length, no sideways scroll at 320, the first Tab and Day's focus ring", async ({
  page,
  pap,
  signedIn,
  browserName,
}) => {
  const longRoot = join(dirname(pap.work), LONG_NAME);
  mkdirSync(longRoot);
  await pap.rpc("projects.add", { root: longRoot });
  await page.setViewportSize(DESKTOP);

  await test.step("an agent paragraph fits 72ch and holds a sane number of characters a line", async () => {
    await signedIn.goto(pap.origin);
    await page.getByLabel(t("launch.field"), { exact: true }).fill("Summarise the release");
    await page.getByRole("button", { name: t("launch.go.session"), exact: true }).click();
    await page.getByRole("button", { name: basename(pap.work), exact: true }).click();
    const paragraph = page.locator("p", { hasText: "Summary: The release notes" });
    await expect(paragraph).toBeVisible();
    const { characters, width, probe } = await paragraph.evaluate(measureLines);
    expect(characters).toBeGreaterThan(40); // it wrapped at a real width, not into one character a line
    expect(width).toBeLessThanOrEqual(probe + SLACK);
    expect(characters).toBeLessThanOrEqual(MAX_CHARACTERS[browserName === "webkit" ? "webkit" : "chromium"]);
  });

  await test.step("the first Tab of a page lands on the skip link, Enter focuses the pane", async () => {
    await page.goto(`${pap.origin}/settings/appearance`);
    await expect(
      page.getByRole("heading", { name: t("settings.section.appearance"), level: 1, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: t("shell.skip"), exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#pane-host")).toBeFocused();
  });

  await test.step("Day: the focus outline of the active tab reaches 3:1", async () => {
    await page.goto(`${pap.origin}/settings/appearance`);
    await page.getByRole("radio", { name: t("settings.appearance.mode.day"), exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "day");
    const tab = page.getByRole("tab", { selected: true });
    await expect(tab).toBeVisible();
    await page.keyboard.press("Shift"); // keyboard modality, so the programmatic focus shows its ring
    await tab.focus();
    const { outline, outlineWidth, background } = await page.evaluate(paintOf);
    expect(outlineWidth).toBeGreaterThan(0);
    expect(contrast(outline, background)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  await test.step("at 320 px no page is wider than the screen, with a long project name", async () => {
    await page.setViewportSize(PHONE);
    await page.goto(pap.origin);
    const chip = (name: string) =>
      page.getByRole("banner").getByRole("button", { name: t("shell.project.label", { name }), exact: true });
    await chip(t("shell.project.all")).click();
    await page.getByText(LONG_NAME, { exact: true }).click();
    await expect(chip(LONG_NAME)).toBeVisible();
    await noSidewaysScroll(page);
    const { sessions } = await pap.rpc<{ sessions: { id: string }[] }>("sessions.list");
    for (const path of [
      "/",
      `/s/${sessions[0]?.id}`,
      "/settings/appearance",
      "/settings/automation",
      "/tasks",
    ]) {
      await page.goto(`${pap.origin}${path}`);
      await expect(page.getByRole("main").or(page.locator("#pane-host")).first()).toBeVisible();
      await noSidewaysScroll(page);
    }
    await page.goto(pap.origin);
    await page.getByRole("radio", { name: t("launch.mode.trigger"), exact: true }).click();
    await page.getByLabel(t("launch.field"), { exact: true }).fill("Nightly check");
    await page.getByRole("button", { name: t("launch.go.trigger"), exact: true }).click();
    await expect(page.getByLabel(t("automation.editor.name"), { exact: true })).toBeVisible();
    await noSidewaysScroll(page);
  });

  const { sessions } = await pap.rpc<{ sessions: { id: string }[] }>("sessions.list");
  expect(sessions).toHaveLength(1);
});

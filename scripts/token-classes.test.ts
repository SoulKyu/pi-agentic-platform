import { describe, expect, it } from "vitest";
import { compileStyles, ruleOf } from "./tailwind-compile.ts";

async function rule(className: string): Promise<string> {
  const build = await compileStyles();
  return ruleOf(build([className]), className);
}

describe("the token utilities compile to the DESIGN.md variables", () => {
  it.each([
    ["bg-surface-2", "var(--surface-2)"],
    ["text-fg", "var(--text)"],
    ["text-muted", "var(--text-muted)"],
    ["bg-you-fill", "var(--you-fill)"],
    ["text-agent-ink", "var(--agent-ink)"],
    ["border-control-border", "var(--control-border)"],
    ["text-attn-title", "var(--attn-title)"],
    ["bg-surface", "var(--surface)"],
    ["text-attn", "var(--attn)"],
    ["text-err", "var(--err)"],
    ["text-you-ink", "var(--you-ink)"],
    ["p-s3", "var(--space-3)"],
    ["gap-s1", "var(--space-1)"],
    ["h-control", "var(--control-h)"],
    ["w-rail", "var(--rail-w)"],
    ["size-avatar", "var(--avatar-size)"],
    ["w-drawer-tree", "18.75rem"],
    ["min-w-pane", "20rem"],
    ["text-ui", "var(--size-ui)"],
    ["label-hud", "var(--label-transform)"],
    ["shadow-overlay", "var(--shadow-overlay)"],
    ["bg-grid", "var(--grid-size)"],
    ["h-app", "var(--app-viewport-height, 100dvh)"],
    ["pb-safe", "env(safe-area-inset-bottom"],
    ["duration-fast", "var(--motion-fast)"],
    ["max-w-chat", "var(--chat-max-width)"],
    ["rounded-sm", "2px"],
    ["rounded-md", "3px"],
  ])("%s → %s", async (className, expected) => {
    expect(await rule(className)).toContain(expected);
  });

  it("max-w-measure reads --spacing-measure through --prose-measure", async () => {
    expect(await rule("max-w-measure")).toContain("var(--prose-measure)");
  });

  it("max-w-settings is 48rem", async () => {
    expect(await rule("max-w-settings")).toContain("48rem");
  });

  it("max-xs:hidden applies under 25rem", async () => {
    const css = (await compileStyles())(["max-xs:hidden"]);
    expect(css).toMatch(/@media \(width < 25rem\)/);
    expect(css).toContain("display: none");
  });

  it("no longer compiles the M1 alias utilities (post-merge task P1)", async () => {
    const aliases = [
      "bg-panel",
      "border-line",
      "text-attention",
      "outline-human-fill",
      "text-on-fill",
      "text-error",
      "bg-human-tint",
      "border-human-line",
      "bg-attention-tint",
      "border-attention-line",
    ];
    const css = (await compileStyles())(aliases);
    for (const name of aliases) expect(ruleOf(css, name), name).toBe("");
  });

  it("compiles @theme inline, @utility and the custom variants rather than passing them through", async () => {
    const css = (await compileStyles())(["bg-surface-2", "focus-ring", "state-open:opacity-100"]);
    expect(css).not.toMatch(/@theme|@utility|@custom-variant/);
  });

  it("draws the focus ring on :focus-visible with the focus token", async () => {
    const css = (await compileStyles())(["focus-ring"]);
    expect(css).toMatch(/focus-visible/);
    expect(css).toContain("outline: 2px solid var(--focus-ring)");
    expect(css).toContain("outline-offset: 2px");
  });

  it("knows the state, hover and rail variants", async () => {
    const build = await compileStyles();
    expect(build(["state-open:opacity-100"])).toContain('[data-state="open"]');
    expect(build(["state-checked:bg-agent-fill"])).toContain('[data-state="checked"]');
    expect(build(["can-hover:hover:bg-surface-2"])).toContain("@media (hover: hover)");
    expect(build(["rail-right:flex-row-reverse"])).toContain('[data-rail="right"]');
  });

  it("compiles nothing for a default palette colour, and finds a rule by exact class only", async () => {
    expect(await rule("bg-red-500")).toBe("");
    expect(ruleOf(".bg-surface-2 { x: 1; }", "bg-surface")).toBe("");
    expect(ruleOf("html[data-keyboard-open] .pb-safe { padding-bottom: 0; }", "pb-safe")).toBe("");
  });
});

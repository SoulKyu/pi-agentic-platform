// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTheme } from "./derive.ts";
import {
  downloadThemeFile,
  exportThemeFile,
  MAX_THEME_FILE_BYTES,
  newThemeId,
  parseThemeFile,
  presetRoles,
  readThemeFile,
  themeFileErrors,
} from "./theme-io.ts";

const example =
  '{"name":"My theme","base":"night","roles":{"bg":"#0E1626","surface":"#132033","agent":"#38BDF8","you":"#FB923C","attn":"#EC4899","ok":"#34D399","err":"#F87171","text":"#E6EDF7"}}';

afterEach(() => vi.restoreAllMocks());

describe("theme files (DESIGN.md §13.1)", () => {
  it("reads DESIGN's example and writes it back without an id, as 2-space JSON", () => {
    const parsed = parseThemeFile(example);
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.theme.name).toBe("My theme");
    const written = exportThemeFile({ id: "x", ...parsed.theme });
    expect(JSON.parse(written)).toEqual(JSON.parse(example));
    expect(written).toBe(`${JSON.stringify(parsed.theme, null, 2)}\n`);
    expect(written.startsWith('{\n  "name": "My theme",\n  "base": "night",\n  "roles": {\n    "bg"')).toBe(
      true,
    );
    expect(written).not.toContain('"id"');
  });

  it("says what is wrong, entry by entry", () => {
    expect(parseThemeFile("{oops")).toEqual({ ok: false, errors: [{ kind: "not_json" }] });
    expect(parseThemeFile("x".repeat(MAX_THEME_FILE_BYTES + 1))).toEqual({
      ok: false,
      errors: [{ kind: "too_large" }],
    });
    const hostile = JSON.parse(example);
    hostile.roles.bg = "url(https://x.test/a.png)";
    delete hostile.roles.agent;
    const result = parseThemeFile(JSON.stringify(hostile));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => (e.kind === "invalid" ? e.path : e.kind)).sort()).toEqual([
        "roles.agent",
        "roles.bg",
      ]);
  });

  it("measures the size in bytes, not in characters", () => {
    const wide = "é".repeat(MAX_THEME_FILE_BYTES / 2 + 1);
    expect(wide.length).toBeLessThanOrEqual(MAX_THEME_FILE_BYTES);
    expect(parseThemeFile(wide)).toEqual({ ok: false, errors: [{ kind: "too_large" }] });
  });

  it("keeps at most 20 errors and clips what it will show of a path", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `roles.${"k".repeat(200)}${i}`);
    const errors = themeFileErrors(paths);
    expect(errors).toHaveLength(20);
    for (const error of errors) {
      expect(error.kind).toBe("invalid");
      if (error.kind === "invalid") expect(error.path.length).toBe(64);
    }
  });

  it("refuses an oversize file before reading it, and reads a small one", async () => {
    const text = vi.fn(async () => example);
    const huge = { size: MAX_THEME_FILE_BYTES + 1, text } as unknown as File;
    expect(await readThemeFile(huge)).toEqual({ ok: false, errors: [{ kind: "too_large" }] });
    expect(text).not.toHaveBeenCalled();
    const small = { size: example.length, text } as unknown as File;
    const read = await readThemeFile(small);
    expect(read.ok).toBe(true);
    expect(text).toHaveBeenCalledOnce();
  });

  it("re-checks the size of the text it did read", async () => {
    const lying = { size: 10, text: async () => "x".repeat(MAX_THEME_FILE_BYTES + 1) } as unknown as File;
    expect(await readThemeFile(lying)).toEqual({ ok: false, errors: [{ kind: "too_large" }] });
  });

  it("reports a file that cannot be read as not JSON", async () => {
    const broken = {
      size: 10,
      text: async () => {
        throw new Error("gone");
      },
    } as unknown as File;
    expect(await readThemeFile(broken)).toEqual({ ok: false, errors: [{ kind: "not_json" }] });
  });

  it("makes unique ids that follow the id rule and never take a preset's id", () => {
    expect(newThemeId("My Theme!", new Set())).toBe("my-theme");
    expect(newThemeId("My Theme!", new Set(["my-theme"]))).toBe("my-theme-2");
    expect(newThemeId("夜", new Set())).toBe("theme");
    expect([
      newThemeId("Day", new Set()),
      newThemeId("HC", new Set()),
      newThemeId("Night", new Set()),
    ]).toEqual(["day-2", "hc-2", "night-2"]);
  });

  it("duplicates a preset with its fills as roles, so the primary button keeps the you fill (M3-RT-32)", () => {
    expect(presetRoles("day")).toMatchObject({
      agent: "#7c3aed",
      you: "#fb923c",
      attn: "#db2777",
      bg: "#faf9f6",
    });
    expect(
      deriveTheme({ id: "copy", name: "copy", base: "day", roles: presetRoles("day") })["you-fill"],
    ).toBe("#fb923c");
  });

  it("downloads through a Blob URL that is revoked right after the click", async () => {
    const order: string[] = [];
    let blob: Blob | undefined;
    const create = vi.fn((made: Blob) => {
      blob = made;
      order.push("create");
      return "blob:pap/1";
    });
    const revoke = vi.fn(() => order.push("revoke"));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    let download = "";
    let href = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      order.push("click");
      download = this.download;
      href = this.href;
    });
    const parsed = parseThemeFile(example);
    if (!parsed.ok) throw new Error("parse");
    downloadThemeFile({ id: "my-theme", ...parsed.theme });
    expect(order).toEqual(["create", "click", "revoke"]);
    expect([download, href, revoke.mock.calls[0]]).toEqual(["my-theme.json", "blob:pap/1", ["blob:pap/1"]]);
    expect(blob?.type).toBe("application/json");
    expect(await blob?.text()).toBe(exportThemeFile({ id: "my-theme", ...parsed.theme }));
    expect(document.querySelector("a[download]")).toBeNull();
    vi.unstubAllGlobals();
  });
});

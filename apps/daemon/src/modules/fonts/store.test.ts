import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFontsStore } from "./store.ts";

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-fonts-store-"));
  root = join(home, "fonts");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NAME = "0123456789abcdef.woff2";
const install = (slug = "inter", name = NAME) =>
  createFontsStore(root).install(
    { slug, family: "Inter", addedAt: 5 },
    "css",
    new Map([[name, Buffer.from("wOF2abc")]]),
  );

describe("fonts store", () => {
  it("installs a family whole, with private modes, and reads it back", () => {
    const stored = install();
    expect(stored).toMatchObject({ slug: "inter", family: "Inter", files: [NAME], bytes: 7 });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "inter")).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(join(root, "inter")))
      expect(statSync(join(root, "inter", file)).mode & 0o777, file).toBe(0o600);
    const store = createFontsStore(root);
    expect(store.get("inter")).toEqual(stored);
    expect(store.read("inter", NAME)).toMatchObject({ size: 7, type: "font/woff2" });
    expect(store.read("inter", "font.css")).toMatchObject({ type: "text/css; charset=utf-8" });
    expect(store.read("inter", "meta.json")).toBeNull();
  });

  it("leaves no staging folder behind when a write fails, and does not replace an installed family", () => {
    install();
    expect(() => install("inter", "0123456789abcdef.woff2")).toThrow();
    expect(readdirSync(root)).toEqual(["inter"]);
    expect(createFontsStore(root).get("inter")).toMatchObject({ files: [NAME] });
  });

  it("lists only well formed families, ignoring staging folders, junk and unreadable records", () => {
    install("inter");
    mkdirSync(join(root, ".tmp-x"));
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "meta.json"), "{not json");
    mkdirSync(join(root, "wrong"));
    writeFileSync(
      join(root, "wrong", "meta.json"),
      JSON.stringify({ family: "x/y", addedAt: 1, files: [], bytes: 0 }),
    );
    writeFileSync(join(root, "Stray.txt"), "x");
    expect(
      createFontsStore(root)
        .list()
        .map((entry) => entry.slug),
    ).toEqual(["inter"]);
  });

  it("never reads or removes anything outside a family folder, whatever the slug or file says", () => {
    install();
    // a record and a font planted one level above the fonts folder, as a traversal would reach them
    writeFileSync(
      join(home, "meta.json"),
      JSON.stringify({ family: "Evil", addedAt: 1, files: [NAME], bytes: 1 }),
    );
    writeFileSync(join(home, NAME), "x");
    const store = createFontsStore(root);
    for (const slug of ["..", ".", "../fonts", "inter/..", "", "Inter", "a/b"]) {
      expect(store.get(slug), slug).toBeNull();
      expect(store.read(slug, NAME), slug).toBeNull();
      expect(store.remove(slug), slug).toBe(false);
    }
    for (const file of ["../meta.json", `../${NAME}`, "", "font.css/", "FONT.CSS", `${NAME}\0`])
      expect(store.read("inter", file), JSON.stringify(file)).toBeNull();
    expect(readdirSync(home).sort()).toEqual(["fonts", "meta.json", NAME].sort());
  });

  it("serves a regular file only: a symlink in the folder is refused", () => {
    install();
    writeFileSync(join(home, "secret"), "do not serve");
    rmSync(join(root, "inter", NAME));
    symlinkSync(join(home, "secret"), join(root, "inter", NAME));
    expect(createFontsStore(root).read("inter", NAME)).toBeNull();
  });

  it("removes a family and reports whether it existed", () => {
    install();
    const store = createFontsStore(root);
    expect(store.remove("inter")).toBe(true);
    expect(store.remove("inter")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("logs a record it cannot read once, with the slug and nothing else, and treats the folder as absent", () => {
    install();
    writeFileSync(join(root, "inter", "meta.json"), "{broken");
    const lines: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, fields: unknown) => lines.push([msg, fields]) } as never;
    const store = createFontsStore(root, logger);
    expect(store.get("inter")).toBeNull();
    expect(store.read("inter", NAME)).toBeNull();
    expect(store.list()).toEqual([]);
    expect(lines).toEqual([["font_record_corrupt", { slug: "inter" }]]);
  });

  it("an install replaces a folder that has no valid record, but never one that has", () => {
    mkdirSync(join(root, "inter"), { recursive: true });
    writeFileSync(join(root, "inter", "leftover"), "x");
    expect(install().files).toEqual([NAME]);
    expect(readdirSync(join(root, "inter")).sort()).toEqual(["font.css", "meta.json", NAME].sort());
    expect(() => install()).toThrow();
    expect(createFontsStore(root).get("inter")).toMatchObject({ files: [NAME] });
  });

  it("list sweeps staging and trash folders left by a crash, and remove leaves no trash behind", () => {
    install();
    install("other");
    mkdirSync(join(root, ".tmp-1"));
    mkdirSync(join(root, ".tmp-trash-2"));
    writeFileSync(join(root, ".tmp-trash-2", "x"), "x");
    const store = createFontsStore(root);
    expect(store.list().map((entry) => entry.slug)).toEqual(["inter", "other"]);
    expect(readdirSync(root).sort()).toEqual(["inter", "other"]);
    expect(store.remove("inter")).toBe(true);
    expect(readdirSync(root)).toEqual(["other"]);
  });

  it("a staging folder that cannot be removed does not fail the list: it is logged and the list goes on", () => {
    install();
    const stuck = join(root, ".tmp-stuck", "inner");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "f"), "x");
    chmodSync(stuck, 0o500); // a file in a read-only folder cannot be unlinked
    const lines: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, fields: unknown) => lines.push([msg, fields]) } as never;
    try {
      expect(
        createFontsStore(root, logger)
          .list()
          .map((entry) => entry.slug),
      ).toEqual(["inter"]);
      expect(lines).toEqual([["font_sweep_failed", { name: ".tmp-stuck" }]]);
    } finally {
      chmodSync(stuck, 0o700);
    }
  });
});

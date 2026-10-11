import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { translate } from "../i18n/index.ts";

vi.mock("../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

it("loading the gallery registers its strings, and its first import is the registration", async () => {
  expect(translate("en", "gallery.theme")).toBe("gallery.theme");
  await import("./Gallery.tsx");
  expect(translate("en", "gallery.theme")).toBe("Theme");
  expect(translate("fr", "gallery.theme")).toBe("Thème");
  const source = readFileSync(join(import.meta.dirname, "Gallery.tsx"), "utf8");
  expect(source.split("\n")[0]).toBe('import "./register-gallery-catalog.ts";');
});

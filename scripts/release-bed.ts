import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { preFlipShape } from "./release-flip.ts";

/** The repository the release tests read: this checkout, or the flipped copy that the rehearsal test points them at. */
export const REPO = process.env.PAP_FLIP_REPO ?? resolve(import.meta.dirname, "..");

/** Copies a repository file into `copy`; a file the flip rewrites arrives in its pre-flip shape. */
export function copyPreFlip(file: string, copy: string): void {
  mkdirSync(dirname(join(copy, file)), { recursive: true });
  const text = readFileSync(join(REPO, file), "utf8");
  const pre = preFlipShape(file, text);
  if (pre === text) cpSync(join(REPO, file), join(copy, file));
  else writeFileSync(join(copy, file), pre);
}

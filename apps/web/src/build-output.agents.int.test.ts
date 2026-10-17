import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { EAGER_FORBIDDEN } from "./build-output.markers.ts";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

let out = "";
let html = "";
let assets: string[] = [];

// The same build `build-output.int.test.ts` makes: what index.ts names is eager, the rest loads on demand.
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pap-web-agents-build-"));
  vi.stubEnv("NODE_ENV", "production");
  await build({
    root: webRoot,
    logLevel: "silent",
    resolve: { alias: { "@pap/contracts": join(repoRoot, "packages/contracts/src/index.ts") } },
    build: { outDir: out, emptyOutDir: true },
  });
  html = await readFile(join(out, "index.html"), "utf8");
  assets = await readdir(join(out, "assets"));
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(out, { recursive: true, force: true });
});

describe("the agent screens stay out of the eager bundle (M11R110)", () => {
  // The files index.html names, and the chunks they import statically: all of it loads before the first paint.
  const eagerFiles = async (): Promise<Map<string, string>> => {
    const text = new Map<string, string>();
    for (const name of assets.filter((asset) => asset.endsWith(".js")))
      text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const eager = new Map<string, string>();
    const visit = (name: string) => {
      const code = text.get(name);
      if (code === undefined || eager.has(name)) return;
      eager.set(name, code);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(match[1] ?? "");
    };
    for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) visit(match[1] ?? "");
    return eager;
  };

  for (const { component, marker } of EAGER_FORBIDDEN) {
    it(`has no ${component} marker in an eager file`, async () => {
      const eager = await eagerFiles();
      expect(eager.size).toBeGreaterThan(0);
      const holders = [...eager].filter(([, code]) => marker.test(code)).map(([name]) => name);
      expect(holders).toEqual([]);
      // The marker is real: a lazy chunk does hold it, so a rename cannot make this test pass by accident.
      const lazy: string[] = [];
      for (const name of assets.filter((asset) => asset.endsWith(".js")))
        if (!eager.has(name) && marker.test(await readFile(join(out, "assets", name), "utf8")))
          lazy.push(name);
      expect(lazy.length, String(marker)).toBeGreaterThan(0);
    });
  }

  it("keeps the rail itself eager: its New agent button is in the initial files", async () => {
    const eager = await eagerFiles();
    expect([...eager.values()].some((code) => /data-slot":\W*agent-rail/.test(code))).toBe(true);
  });
});

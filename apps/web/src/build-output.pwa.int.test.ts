import { readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

let out = "";
let html = "";

// The same build `build-output.int.test.ts` makes; this file holds what the PWA adds to it.
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pap-web-pwa-build-"));
  vi.stubEnv("NODE_ENV", "production");
  await build({
    root: webRoot,
    logLevel: "silent",
    resolve: { alias: { "@pap/contracts": join(repoRoot, "packages/contracts/src/index.ts") } },
    build: { outDir: out, emptyOutDir: true },
  });
  html = await readFile(join(out, "index.html"), "utf8");
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(out, { recursive: true, force: true });
});

describe("the built web app as a PWA (M12R27)", () => {
  it("copies the manifest and every icon into dist", async () => {
    const manifest = JSON.parse(await readFile(join(out, "manifest.webmanifest"), "utf8")) as {
      icons: { src: string }[];
    };
    const files = [
      ...manifest.icons.map((icon) => icon.src),
      "/icons/badge-96.png",
      "/icons/apple-touch-icon.png",
    ];
    expect(files).toHaveLength(5);
    for (const file of files) expect((await stat(join(out, file))).size, file).toBeGreaterThan(0);
  });

  it("references the manifest and the apple icon from index.html", () => {
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('href="/icons/apple-touch-icon.png"');
  });

  it("adds no JavaScript chunk to the page: the head names only the boot script and the entry", async () => {
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="\/assets\/([^"]+\.js)"/g)].map((m) => m[1] ?? "");
    expect(scripts.map((name) => name.replace(/-[\w-]{8,10}\.js$/, "")).sort()).toEqual([
      "appearance-boot",
      "index",
    ]);
  });
});

describe("the built service worker (M12R14, M12R28)", () => {
  const publicDir = join(webRoot, "public");
  const assetsOf = () =>
    readdirSync(join(out, "assets"))
      .filter((name) => !name.endsWith(".map"))
      .map((name) => `/assets/${name}`)
      .sort();
  const publicFiles = () => [
    "/favicon.svg",
    "/manifest.webmanifest",
    ...readdirSync(join(publicDir, "icons"))
      .sort()
      .map((name) => `/icons/${name}`),
  ];

  it("is a classic script at the dist root with every placeholder replaced", async () => {
    const sw = await readFile(join(out, "sw.js"), "utf8");
    expect(() => new Function(sw)).not.toThrow();
    expect(sw).not.toMatch(/^\s*(?:import|export)\s/m);
    expect(sw).not.toMatch(/\bimport\s*[({]/);
    expect(sw).not.toContain("__BUILD_ID__");
    expect(sw).not.toContain("__SHELL__");
  });

  it("precaches index.html, every emitted asset (lazy chunks included) and the public files", async () => {
    const sw = await readFile(join(out, "sw.js"), "utf8");
    const list = /(\["\/","\/index\.html"[^\]]*\])/.exec(sw)?.[1];
    expect(list, "the inlined shell list").toBeDefined();
    const shell = JSON.parse(list ?? "[]") as string[];
    expect(shell).toContain("/index.html");
    expect(shell.slice(0, 2)).toEqual(["/", "/index.html"]);
    expect(shell.slice(2)).toEqual([...assetsOf(), ...publicFiles()]);
    expect(assetsOf().length).toBeGreaterThan(3);
  });

  it("names its cache with a 16-hex build id", async () => {
    const sw = await readFile(join(out, "sw.js"), "utf8");
    expect(sw).toMatch(/"[0-9a-f]{16}"/);
  });

  it("stays within the service worker size budget", async () => {
    const budget = (
      JSON.parse(await readFile(join(repoRoot, "budgets.json"), "utf8")) as { serviceWorkerGzipKb: number }
    ).serviceWorkerGzipKb;
    const gzipKb = gzipSync(await readFile(join(out, "sw.js")), { level: 9 }).length / 1024;
    expect(gzipKb).toBeLessThanOrEqual(budget);
  });

  it("precaches every file of dist: the dist root equals the shell list plus sw.js", async () => {
    const sw = await readFile(join(out, "sw.js"), "utf8");
    const shell = JSON.parse(/(\["\/","\/index\.html"[^\]]*\])/.exec(sw)?.[1] ?? "[]") as string[];
    const walk = (dir: string): string[] =>
      readdirSync(join(out, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
      );
    const files = walk("").map((path) => path.replace(/^\/\//, "/"));
    expect(files.sort()).toEqual([...shell.filter((path) => path !== "/"), "/sw.js"].sort());
  });

  it("the built, minified worker passes /auth through and sends an evil click to /", async () => {
    const sw = await readFile(join(out, "sw.js"), "utf8");
    const listeners = new Map<string, (event: unknown) => void>();
    const openWindow = vi.fn(() => Promise.resolve(null));
    class ServiceWorkerGlobalScope {
      location = { origin: "https://pap.test", href: "https://pap.test/sw.js" };
      clients = { claim: vi.fn(), matchAll: () => Promise.resolve([]), openWindow };
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
    }
    runInNewContext(sw, {
      ServiceWorkerGlobalScope,
      self: new ServiceWorkerGlobalScope(),
      caches: {},
      fetch: vi.fn(),
      URL,
      Request,
      Response,
      AbortController,
      setTimeout,
      clearTimeout,
    });
    const respondWith = vi.fn();
    listeners.get("fetch")?.({
      request: { method: "GET", mode: "navigate", url: "https://pap.test/auth/session" },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
    const waits: Promise<unknown>[] = [];
    listeners.get("notificationclick")?.({
      notification: { close: vi.fn(), data: { id: "//evil.example" } },
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    });
    await Promise.all(waits);
    expect(openWindow).toHaveBeenCalledWith("https://pap.test/");
  });
});

describe("the update banner stays lazy (M12R30)", () => {
  const marker = /data-update-banner/;
  const reachable = async (): Promise<Map<string, string>> => {
    const names = (await readdir(join(out, "assets"))).filter((name) => name.endsWith(".js"));
    const text = new Map<string, string>();
    for (const name of names) text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const eager = new Map<string, string>();
    const visit = (name: string) => {
      const code = text.get(name);
      if (code === undefined || eager.has(name)) return;
      eager.set(name, code);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(match[1] ?? "");
    };
    for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) visit(match[1] ?? "");
    return new Map([...text].map(([name, code]) => [name, eager.has(name) ? `EAGER${code}` : code]));
  };

  it("keeps UpdateBanner and its strings out of the initial chunk, in a lazy one", async () => {
    const all = await reachable();
    const holders = [...all].filter(([, code]) => marker.test(code));
    expect(holders.length).toBeGreaterThan(0);
    expect(holders.filter(([, code]) => code.startsWith("EAGER")).map(([name]) => name)).toEqual([]);
    for (const text of ["The page has an update", "La page a une mise à jour"]) {
      const where = [...all].filter(([, code]) => code.includes(text));
      expect(where.length, text).toBeGreaterThan(0);
      expect(where.filter(([, code]) => code.startsWith("EAGER")).map(([name]) => name)).toEqual([]);
    }
  });
});

describe("the push client stays lazy (M12R12)", () => {
  const reachable = async (): Promise<Map<string, string>> => {
    const names = (await readdir(join(out, "assets"))).filter((name) => name.endsWith(".js"));
    const text = new Map<string, string>();
    for (const name of names) text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const eager = new Map<string, string>();
    const visit = (name: string) => {
      const code = text.get(name);
      if (code === undefined || eager.has(name)) return;
      eager.set(name, code);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(match[1] ?? "");
    };
    for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) visit(match[1] ?? "");
    return new Map([...text].map(([name, code]) => [name, eager.has(name) ? `EAGER${code}` : code]));
  };

  it("keeps enablePush, bindPush and their strings out of the initial chunk, in lazy ones", async () => {
    const all = await reachable();
    const markers = [
      "userVisibleOnly",
      "Réactiver les notifications",
      "Les notifications et l'installation demandent HTTPS.",
      "push_unsubscribe_failed",
    ];
    for (const marker of markers) {
      const holders = [...all].filter(([, code]) => code.includes(marker));
      expect(holders.length, marker).toBeGreaterThan(0);
      expect(
        holders.filter(([, code]) => code.startsWith("EAGER")).map(([name]) => name),
        marker,
      ).toEqual([]);
    }
  });

  it("keeps presence in the initial chunk: it must run for every signed-in page", async () => {
    const all = await reachable();
    const holders = [...all].filter(([, code]) => code.includes("push.presence"));
    expect(holders.some(([, code]) => code.startsWith("EAGER"))).toBe(true);
  });
});

describe("Settings > Notifications stays lazy (M12)", () => {
  const reachable = async (): Promise<Map<string, string>> => {
    const names = (await readdir(join(out, "assets"))).filter((name) => name.endsWith(".js"));
    const text = new Map<string, string>();
    for (const name of names) text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const eager = new Map<string, string>();
    const visit = (name: string) => {
      const code = text.get(name);
      if (code === undefined || eager.has(name)) return;
      eager.set(name, code);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(match[1] ?? "");
    };
    for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) visit(match[1] ?? "");
    return new Map([...text].map(([name, code]) => [name, eager.has(name) ? `EAGER${code}` : code]));
  };

  it("keeps the panel, its devices list and its strings out of the initial chunk, in a lazy one", async () => {
    const all = await reachable();
    const markers = [
      "data-notifications-settings",
      "What notifies you",
      "Afficher le nom du déclencheur ou de l'agent",
      "notifications.mute.forever",
    ];
    for (const marker of markers) {
      const holders = [...all].filter(([, code]) => code.includes(marker));
      expect(holders.length, marker).toBeGreaterThan(0);
      expect(
        holders.filter(([, code]) => code.startsWith("EAGER")).map(([name]) => name),
        marker,
      ).toEqual([]);
    }
  });
});

describe("the /n/<id> landing stays lazy (M12)", () => {
  const reachable = async (): Promise<Map<string, string>> => {
    const names = (await readdir(join(out, "assets"))).filter((name) => name.endsWith(".js"));
    const text = new Map<string, string>();
    for (const name of names) text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const eager = new Map<string, string>();
    const visit = (name: string) => {
      const code = text.get(name);
      if (code === undefined || eager.has(name)) return;
      eager.set(name, code);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(match[1] ?? "");
    };
    for (const match of html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)) visit(match[1] ?? "");
    return new Map([...text].map(([name, code]) => [name, eager.has(name) ? `EAGER${code}` : code]));
  };

  it("keeps the landing screen and its strings out of the initial chunk, in a lazy one", async () => {
    const all = await reachable();
    const markers = ["data-landing-skeleton", "Cette notification n'existe plus", "Already handled"];
    for (const marker of markers) {
      const holders = [...all].filter(([, code]) => code.includes(marker));
      expect(holders.length, marker).toBeGreaterThan(0);
      expect(
        holders.filter(([, code]) => code.startsWith("EAGER")).map(([name]) => name),
        marker,
      ).toEqual([]);
    }
  });
});

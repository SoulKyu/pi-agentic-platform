import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildIdOf, inlineConstants, renderServiceWorker, serviceWorker } from "../vite/service-worker.ts";

const source = readFileSync(new URL("./sw.ts", import.meta.url), "utf8");
const SHELL = ["/", "/index.html", "/assets/index-a.js", "/assets/lazy-a.js"];

describe("renderServiceWorker (M12R28)", () => {
  let out = "";
  beforeAll(async () => {
    out = await renderServiceWorker(source, SHELL, "0123456789abcdef");
  });

  it("is a classic script: no import or export token, no left-over placeholder", () => {
    expect(out).not.toMatch(/^\s*(?:import|export)\s/m);
    expect(out).not.toMatch(/\bimport\(|\bimport\s*\{/);
    expect(out).not.toContain("__BUILD_ID__");
    expect(out).not.toContain("__SHELL__");
    expect(out).toContain('"0123456789abcdef"');
    expect(out).toContain("pap-shell-");
    expect(out).toContain(JSON.stringify(SHELL));
  });

  it("parses as a classic script (new Function), types stripped", () => {
    expect(() => new Function(out)).not.toThrow();
    expect(out).not.toMatch(/\binterface\b|: SwScope|\bas unknown as\b|\/\/ /);
  });

  it("registers its listeners only inside a ServiceWorkerGlobalScope", () => {
    const outside = vi.fn();
    runInNewContext(out, {
      caches: {},
      console,
      URL,
      Request,
      Response,
      fetch: outside,
      setTimeout,
      clearTimeout,
      AbortController,
    });
    expect(outside).not.toHaveBeenCalled();

    const types: string[] = [];
    class ServiceWorkerGlobalScope {
      location = { origin: "https://pap.test", href: "https://pap.test/sw.js" };
      addEventListener(type: string) {
        types.push(type);
      }
    }
    runInNewContext(out, {
      ServiceWorkerGlobalScope,
      self: new ServiceWorkerGlobalScope(),
      caches: {},
      URL,
      Request,
      Response,
      fetch,
      setTimeout,
      clearTimeout,
      AbortController,
    });
    expect(types.sort()).toEqual([
      "activate",
      "fetch",
      "install",
      "message",
      "notificationclick",
      "push",
      "pushsubscriptionchange",
    ]);
  });
});

describe("build-id-covers-manifest-and-icons", () => {
  const files = () =>
    new Map<string, string | Uint8Array>([
      ["/index.html", "<html></html>"],
      ["/assets/index-a.js", "console.log(1)"],
      ["/manifest.webmanifest", '{"name":"pap"}'],
      ["/icons/icon-192.png", new Uint8Array([1, 2, 3])],
    ]);

  it("is 16 hex characters and stable regardless of insertion order", () => {
    const id = buildIdOf(files());
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(buildIdOf(new Map([...files()].reverse()))).toBe(id);
  });

  it("changes when the manifest changes", () => {
    const changed = files().set("/manifest.webmanifest", '{"name":"pap2"}');
    expect(buildIdOf(changed)).not.toBe(buildIdOf(files()));
  });

  it("changes when one icon byte changes", () => {
    const changed = files().set("/icons/icon-192.png", new Uint8Array([1, 2, 4]));
    expect(buildIdOf(changed)).not.toBe(buildIdOf(files()));
  });

  it("changes when a file is added", () => {
    const changed = files().set("/assets/lazy-b.js", "x");
    expect(buildIdOf(changed)).not.toBe(buildIdOf(files()));
  });
});

describe("inlineConstants", () => {
  it("inserts values literally: a `$&` in a value is not a replacement pattern", () => {
    expect(inlineConstants("a(__BUILD_ID__,__SHELL__)", ["/$&x"], "id$1")).toBe('a("id$1",["/$&x"])');
  });
});

describe("the plugin on a library build (J1)", () => {
  it("emits nothing and does not need an index.html: only the app's own build has a shell", async () => {
    const plugin = serviceWorker();
    const configResolved = plugin.configResolved as unknown as (config: object) => void;
    configResolved({ publicDir: false, build: { lib: { entry: "probe.tsx" } } });
    const generate = plugin.generateBundle as unknown as {
      handler(this: { emitFile(file: object): void }, options: object, bundle: object): Promise<void>;
    };
    const emitted: object[] = [];
    await generate.handler.call({ emitFile: (file) => void emitted.push(file) }, {}, {});
    expect(emitted).toEqual([]);
  });
});

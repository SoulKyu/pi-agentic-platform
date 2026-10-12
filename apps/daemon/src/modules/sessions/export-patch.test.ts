import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext, Script } from "node:vm";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { captureLogger } from "./testing/helpers.ts";
import { EXPORT_PATCHES, MAX_PATCH_BYTES, patchExportFile, patchExportHtml } from "./export-patch.ts";

// Pi 1.1.0's own template: the export inlines it verbatim into the HTML it writes.
const TEMPLATE = readFileSync(join(getPackageDir(), "dist", "core", "export-html", "template.js"), "utf8");
const html = `<html><body><script>${TEMPLATE}</script></body></html>`;

type Node = { entry: { id: string; timestamp: string }; children: Node[] };
const node = (id: string, at: number): Node => ({
  entry: { id, timestamp: new Date(at).toISOString() },
  children: [],
});
const chain = (depth: number): Node => {
  const root = node("0", 0);
  let at = root;
  for (let i = 1; i < depth; i++) {
    const next = node(String(i), i);
    at.children.push(next);
    at = next;
  }
  return root;
};
const branched = (): Node[] => {
  const root = node("r", 0);
  const late = node("b", 20);
  const early = node("a", 10);
  late.children.push(node("b1", 30));
  root.children.push(late, early);
  return [root, node("r2", 5)];
};
const pieceOf = (name: string, source: string): string =>
  source.match((EXPORT_PATCHES.find((patch) => patch.name === name) as { anchor: RegExp }).anchor)?.[0] ?? "";
// Each helper wrapped so it can run on its own: the original from Pi's template, or pap's replacement.
const runners = (sort: string, map: string, mark: string) => ({
  sort: runInNewContext(`(roots) => { ${sort} roots.forEach(sortChildren); return roots; }`) as (
    roots: Node[],
  ) => Node[],
  map: runInNewContext(
    `(tree) => { const treeNodeMap = new Map(); ${map} return [...treeNodeMap.keys()].sort(); }`,
  ) as (tree: Node[]) => string[],
  mark: runInNewContext(
    `(roots, activePathIds) => { const containsActive = new Map(); ${mark} roots.forEach(markActive); return [...containsActive].map(([n, has]) => n.entry.id + ":" + has).sort(); }`,
  ) as (roots: Node[], active: Set<string>) => string[],
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pap-patch-"));
  dirs.push(dir);
  return dir;
};

describe("export patch (owner M2-Q7)", () => {
  it("finds each helper of Pi 1.1.0's template exactly once and replaces all three", () => {
    for (const patch of EXPORT_PATCHES) expect(TEMPLATE.match(patch.anchor), patch.name).toHaveLength(1);
    const { html: patched, skipped } = patchExportHtml(html);
    expect(skipped).toBeNull();
    expect(patched).not.toContain("node.children.forEach(sortChildren)");
    expect(patched).not.toContain("node.children.forEach(mapNodes)");
    expect(patched).not.toContain("if (markActive(child)) has = true;");
    // The rest of the template is untouched.
    expect(patched.length).toBeLessThan(html.length + 2000);
    expect(patched.startsWith("<html><body><script>")).toBe(true);
    expect(patched.endsWith("</script></body></html>")).toBe(true);
    expect(patched).toContain("function findNewestLeaf(nodeId)");
  });

  it("leaves a template that still parses as a script", () => {
    expect(() => new Script(patchExportHtml(TEMPLATE).html)).not.toThrow();
    expect(patchExportHtml(TEMPLATE).skipped).toBeNull();
  });

  it("serves the file as written when an anchor is missing, and patches nothing", () => {
    const changed = html.replace(
      "node.children.forEach(mapNodes);",
      "node.children.forEach((child) => mapNodes(child));",
    );
    expect(patchExportHtml(changed)).toEqual({ html: changed, skipped: "mapNodes" });
    const first = html.replace("node.children.forEach(sortChildren);", "");
    expect(patchExportHtml(first)).toEqual({ html: first, skipped: "sortChildren" });
    const last = html.replace("if (markActive(child)) has = true;", "has = markActive(child) || has;");
    expect(patchExportHtml(last)).toEqual({ html: last, skipped: "markActive" });
  });

  it("patches nothing when an anchor matches twice (the template was pasted twice)", () => {
    const twice = `${html}${html}`;
    expect(patchExportHtml(twice)).toEqual({ html: twice, skipped: "sortChildren" });
  });

  it("is not fooled by a replacement text that holds $ patterns", () => {
    for (const patch of EXPORT_PATCHES) expect(patch.replacement).not.toMatch(/\$[&'`$\d<]/);
    const { html: patched } = patchExportHtml(html);
    for (const patch of EXPORT_PATCHES) expect(patched).toContain(patch.replacement);
  });

  it("adds no remote resource, no markup and no inline handler", () => {
    for (const patch of EXPORT_PATCHES) {
      expect(patch.replacement, patch.name).not.toMatch(
        /https?:|\/\/|<|\bon[a-z]+\s*=|\beval\b|\bFunction\b|\bimport\b|\bfetch\b|\bXMLHttpRequest\b|\bdocument\b|\bwindow\b|innerHTML|\blocation\b/,
      );
    }
  });

  it("gives the originals' answers on a branched tree, and survives a chain the originals cannot", () => {
    const original = runners(
      pieceOf("sortChildren", TEMPLATE),
      pieceOf("mapNodes", TEMPLATE),
      pieceOf("markActive", TEMPLATE),
    );
    const ours = runners(
      EXPORT_PATCHES[0]?.replacement ?? "",
      EXPORT_PATCHES[1]?.replacement ?? "",
      EXPORT_PATCHES[2]?.replacement ?? "",
    );
    const ids = (roots: Node[]): string[] => roots.flatMap((root) => [root.entry.id, ...ids(root.children)]);
    expect(ids(ours.sort(branched()))).toEqual(ids(original.sort(branched())));
    expect(ids(ours.sort(branched()))).toEqual(["r", "a", "b", "b1", "r2"]);
    expect(ours.map(branched())).toEqual(original.map(branched()));
    expect(ours.mark(branched(), new Set(["b1"]))).toEqual(original.mark(branched(), new Set(["b1"])));
    expect(ours.mark(branched(), new Set(["b1"]))).toEqual([
      "a:false",
      "b1:true",
      "b:true",
      "r2:false",
      "r:true",
    ]);
    expect(ours.mark(branched(), new Set())).toEqual(original.mark(branched(), new Set()));
    expect(() => original.sort([chain(100_000)])).toThrow(RangeError);
    expect(() => ours.sort([chain(100_000)])).not.toThrow();
    expect(ours.map([chain(100_000)])).toHaveLength(100_000);
    const deep = ours.mark([chain(100_000)], new Set(["99999"]));
    expect(deep).toHaveLength(100_000);
    expect(deep.every((line) => line.endsWith(":true"))).toBe(true);
    expect(ours.mark([chain(100_000)], new Set())).toHaveLength(100_000);
  });
});

describe("patching a file", () => {
  it("rewrites the file through a temporary one that is gone afterwards", async () => {
    const path = join(tempDir(), "x.html");
    writeFileSync(path, html);
    await patchExportFile(path, silentLogger);
    expect(readFileSync(path, "utf8")).toBe(patchExportHtml(html).html);
    expect(readdirSync(join(path, ".."))).toEqual(["x.html"]);
  });

  it("serves the file as Pi wrote it, and logs the anchor, when the template changed", async () => {
    const path = join(tempDir(), "x.html");
    const changed = html.replace("node.children.forEach(mapNodes);", "");
    writeFileSync(path, changed);
    const logs = captureLogger();
    await patchExportFile(path, logs.logger);
    expect(readFileSync(path, "utf8")).toBe(changed);
    expect(logs.lines).toEqual([
      expect.objectContaining({ level: "warn", msg: "export_patch_skipped", anchor: "mapNodes" }),
    ]);
    expect(readdirSync(join(path, ".."))).toEqual(["x.html"]);
  });

  it("does not read a file past the bound: it is served as written, and logged", async () => {
    const path = join(tempDir(), "x.html");
    writeFileSync(path, html);
    const logs = captureLogger();
    const bytes = Buffer.byteLength(html);
    await patchExportFile(path, logs.logger, { maxBytes: bytes - 1 });
    expect(readFileSync(path, "utf8")).toBe(html);
    expect(logs.lines).toEqual([
      expect.objectContaining({ level: "warn", msg: "export_patch_too_large", limit: bytes - 1 }),
    ]);
    // At the bound exactly it is patched.
    await patchExportFile(path, silentLogger, { maxBytes: bytes });
    expect(readFileSync(path, "utf8")).toBe(patchExportHtml(html).html);
  });

  it("leaves the file 0600 patched or not, too large or not (Pi writes it under the user's umask)", async () => {
    const mode = (path: string) => statSync(path).mode & 0o777;
    const path = join(tempDir(), "x.html");
    for (const [content, options] of [
      [html, {}],
      [html.replace("node.children.forEach(mapNodes);", ""), {}],
      [html, { maxBytes: 1 }],
    ] as const) {
      writeFileSync(path, content);
      chmodSync(path, 0o644);
      await patchExportFile(path, silentLogger, options);
      expect(mode(path)).toBe(0o600);
    }
  });

  it("bounds the file at 64 MiB by default", () => {
    expect(MAX_PATCH_BYTES).toBe(64 * 1024 * 1024);
  });

  it("never throws for a file it cannot read: the export is served as it is", async () => {
    const logs = captureLogger();
    await expect(patchExportFile("/nonexistent/pap-export.html", logs.logger)).resolves.toBeUndefined();
    expect(logs.lines).toEqual([
      expect.objectContaining({ level: "warn", msg: "export_patch_failed", code: "ENOENT" }),
    ]);
  });

  it("never throws when the temporary file cannot be written", async () => {
    const dir = tempDir();
    const path = join(dir, "x.html");
    writeFileSync(path, html);
    // A directory where the temporary file goes: the write fails, the export stays as Pi wrote it.
    mkdirSync(`${path}.patching`);
    const logs = captureLogger();
    await expect(patchExportFile(path, logs.logger)).resolves.toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(html);
    expect(logs.lines).toEqual([
      expect.objectContaining({ msg: "export_patch_failed", code: "EISDIR" }),
      expect.objectContaining({ msg: "export_patch_cleanup_failed" }),
    ]);
  });
});

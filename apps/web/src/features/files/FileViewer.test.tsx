// @vitest-environment happy-dom
import { FILE_LIMITS, type FileMeta } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { click, mount, settle } from "../../testing/dom.ts";
import "../../i18n/register-files.ts";
import { filesBed, meta } from "./files-bed.ts";
import { FileViewer } from "./FileViewer.tsx";
import { VIEW_LIMIT_BYTES, rawUrl } from "./files.vm.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// CodeMirror has its own tests (@pap/ui); here the editor is a probe of what the viewer hands it.
vi.mock("@pap/ui/code", async () => {
  const { createElement } = await import("react");
  return {
    CodeEditor: (props: { value: string; readOnly?: boolean }) =>
      createElement(
        "pre",
        { "data-slot": "code-editor", "data-readonly": String(props.readOnly) },
        props.value,
      ),
    languageFor: () => null,
  };
});

interface Chunk {
  readonly meta: FileMeta;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
}
let bed: ReturnType<typeof filesBed>;
const chunk = (
  path: string,
  text: string,
  offset: number,
  nextOffset: number | null,
  patch: Partial<FileMeta> = {},
): Chunk => ({
  meta: meta(path, patch),
  text,
  offset,
  nextOffset,
});
const serve = (answers: (params: { path: string; offset?: number }) => Chunk) => {
  bed.handlers["files.read"] = (params) => answers(params as { path: string; offset?: number });
};
const reads = () => bed.called("files.read").map((call) => (call.params as { offset?: number }).offset ?? 0);

beforeEach(() => {
  bed = filesBed({});
  current.runtime = bed.runtime;
});

async function show(path: string) {
  const page = await mount(
    <TooltipProvider>
      <FileViewer path={path} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
const links = (c: HTMLElement) => [...c.querySelectorAll<HTMLAnchorElement>("a[download]")];
const labelled = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

describe("FileViewer", () => {
  it("shows a file that may not be edited in a read-only editor, with no Save", async () => {
    serve(({ path }) => chunk(path, "const a = 1;\n", 0, null, { editable: false }));
    const c = await show("/p/a.ts");
    const editor = c.querySelector('[data-slot="code-editor"]');
    expect(editor?.textContent).toBe("const a = 1;\n");
    expect(editor?.getAttribute("data-readonly")).toBe("true");
    expect(labelled(c, "Save")).toBeUndefined();
  });

  it("opens the editor on a whole editable file", async () => {
    serve(({ path }) => chunk(path, "x", 0, null));
    const c = await show("/p/whole.ts");
    expect(c.querySelector('[data-slot="code-editor"]')?.getAttribute("data-readonly")).toBe("false");
    expect(labelled(c, "Save")).toBeDefined();
  });

  it("keeps a file that is only partly loaded read-only", async () => {
    serve(({ path, offset }) => chunk(path, "x", offset ?? 0, (offset ?? 0) === 0 ? 1 : null));
    const c = await show("/p/part.ts");
    expect(c.querySelector('[data-slot="code-editor"]')?.getAttribute("data-readonly")).toBe("true");
    expect(labelled(c, "Save")).toBeUndefined();
  });

  it("a binary file shows its size and a Download link to the raw route", async () => {
    serve(({ path }) => chunk(path, "", 0, null, { binary: true, size: 2048 }));
    const c = await show("/p/data.bin");
    expect(c.querySelector('[data-slot="code-editor"]')).toBeNull();
    expect(c.textContent).toContain("2 KB");
    const [download] = links(c);
    expect(download?.getAttribute("href")).toBe(
      `/files/raw?path=${encodeURIComponent("/p/data.bin")}&download=1`,
    );
  });

  it("an image is the sandboxed raw route in an <img>, with a Download link", async () => {
    serve(({ path }) => chunk(path, "", 0, null, { binary: true }));
    const c = await show("/p/pic ture.png");
    const image = c.querySelector("img");
    expect(image?.getAttribute("src")).toBe(`/files/raw?path=${encodeURIComponent("/p/pic ture.png")}`);
    expect(image?.getAttribute("src")).toBe(rawUrl("/p/pic ture.png"));
    expect(links(c)[0]?.getAttribute("href")).toBe(rawUrl("/p/pic ture.png", true));
  });

  it("markdown toggles between Preview and Source", async () => {
    serve(({ path }) => chunk(path, "# Title\n\nbody\n", 0, null));
    const c = await show("/p/README.md");
    await vi.waitFor(
      () => expect(c.querySelector("[data-markdown-body], [data-slot='markdown']")).not.toBeNull(),
      {
        timeout: 2000,
      },
    );
    expect(c.querySelector('[data-slot="code-editor"]')).toBeNull();
    const source =
      labelled(c, "Source") ??
      c.querySelector<HTMLElement>('[role="radio"][value="source"], button[value="source"]');
    expect(source).toBeTruthy();
    await click(source as HTMLElement);
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("# Title\n\nbody\n");
    await click((c.querySelector('button[value="preview"]') ?? labelled(c, "Preview")) as HTMLElement);
    expect(c.querySelector('[data-slot="code-editor"]')).toBeNull();
  });

  it("markdown preview injects no HTML, loads no image and links only to http(s) with rel noopener noreferrer", async () => {
    const text = [
      "<img src=x onerror=alert(1)>",
      "",
      "<script>alert(1)</script>",
      "",
      "![remote](https://evil.example/a.png)",
      "",
      "[bad](javascript:alert(1)) [rel](/relative/path) [good](https://example.com/x)",
    ].join("\n");
    serve(({ path }) => chunk(path, text, 0, null));
    const c = await show("/p/README.md");
    await vi.waitFor(() => expect(c.querySelector("[data-markdown-body]")).not.toBeNull(), { timeout: 2000 });
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    const anchors = [...c.querySelectorAll<HTMLAnchorElement>("a:not([download])")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/x"]);
    expect(anchors[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("Load more appends the next chunk, then goes away", async () => {
    serve(({ path, offset }) =>
      offset === undefined || offset === 0 ? chunk(path, "one\n", 0, 4) : chunk(path, "two\n", 4, null),
    );
    const c = await show("/p/a.txt");
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("one\n");
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("one\ntwo\n");
    expect(labelled(c, "Load more")).toBeUndefined();
    expect(reads()).toEqual([0, 4]);
  });

  it("a second chunk of another version reloads from offset 0 with a note; a third change in a row gives up", async () => {
    let version = 0;
    serve(({ path, offset }) => {
      const first = offset === undefined || offset === 0;
      if (!first) version += 1; // every later chunk is of a newer version than the first
      return chunk(path, first ? `v${version}-first\n` : "tail\n", first ? 0 : 9, first ? 9 : null, {
        mtimeMs: 100 + version,
      });
    });
    const c = await show("/p/log.txt");
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.textContent).toContain("The file changed while loading; reloaded.");
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("v1-first\n");
    expect(reads()).toEqual([0, 9, 0]);
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.textContent).toContain("The file changed while loading; reloaded.");
    expect(reads()).toEqual([0, 9, 0, 9, 0]);
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.textContent).toContain("This file keeps changing.");
    expect(c.textContent).not.toContain("reloaded");
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("v3-first\n");
    expect(reads()).toEqual([0, 9, 0, 9, 0, 9, 0]);
  });

  it("a size change alone (same mtime) counts as a change", async () => {
    serve(({ path, offset }) =>
      offset === undefined || offset === 0
        ? chunk(path, "a\n", 0, 2, { size: 10 })
        : chunk(path, "b\n", 2, null, { size: 11 }),
    );
    const c = await show("/p/a.txt");
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.textContent).toContain("The file changed while loading; reloaded.");
  });

  it("offers the whole file for editing only when it came from one version (complete)", async () => {
    serve(({ path }) => chunk(path, "x", 0, null));
    const c = await show("/p/a.txt");
    expect(c.querySelector('[data-complete="true"]')).not.toBeNull();
  });

  it("stops at the viewer cap with a too-large state and the Download link", async () => {
    const step = FILE_LIMITS.readChunkBytes;
    serve(({ path, offset }) => {
      const at = offset ?? 0;
      return chunk(path, `chunk${at / step}\n`, at, at + step, { size: VIEW_LIMIT_BYTES * 2 });
    });
    const c = await show("/p/huge.log");
    for (let index = 1; index < VIEW_LIMIT_BYTES / step - 1; index++) {
      await click(labelled(c, "Load more") as HTMLElement);
      await settle();
    }
    // The next chunk ends one step below the cap: still loadable.
    expect(labelled(c, "Load more")).toBeDefined();
    expect(c.textContent).not.toContain("Too large");
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    // Now the loaded part ends exactly at the cap.
    expect(labelled(c, "Load more")).toBeUndefined();
    expect(c.textContent).toContain("Too large to show here");
    expect(links(c)[0]?.getAttribute("href")).toBe(rawUrl("/p/huge.log", true));
    expect(reads().at(-1)).toBe(VIEW_LIMIT_BYTES - step);
  });

  it("drops the answer of a file that was left before it arrived", async () => {
    let releaseA: (answer: Chunk) => void = () => {};
    bed.handlers["files.read"] = (params) => {
      const { path } = params as { path: string };
      if (path === "/p/a.txt") return new Promise((resolve) => (releaseA = resolve));
      return chunk(path, "from b", 0, null);
    };
    const page = await mount(
      <TooltipProvider>
        <FileViewer path="/p/a.txt" />
      </TooltipProvider>,
    );
    await page.rerender(
      <TooltipProvider>
        <FileViewer path="/p/b.txt" />
      </TooltipProvider>,
    );
    await settle();
    releaseA(chunk("/p/a.txt", "from a", 0, null));
    await settle();
    expect(page.container.querySelector('[data-slot="code-editor"]')?.textContent).toBe("from b");
  });

  it("not_found says the file is gone or outside the project", async () => {
    bed.handlers["files.read"] = () => {
      throw new RpcError("not_found");
    };
    const c = await show("/p/gone.txt");
    expect(c.textContent).toContain("This file is gone or outside the project");
  });

  it("another failure offers to try again", async () => {
    let fail = true;
    bed.handlers["files.read"] = (params) => {
      if (fail) throw new RpcError("internal");
      return chunk((params as { path: string }).path, "ok", 0, null);
    };
    const c = await show("/p/a.txt");
    expect(c.textContent).toContain("Could not read this file");
    fail = false;
    await click(labelled(c, "Try again") as HTMLElement);
    await settle();
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("ok");
  });

  it("a failed Load more keeps the text and says so", async () => {
    serve(({ path, offset }) => {
      if (offset) throw new RpcError("internal");
      return chunk(path, "one", 0, 3);
    });
    const c = await show("/p/a.txt");
    await click(labelled(c, "Load more") as HTMLElement);
    await settle();
    expect(c.textContent).toContain("Could not load more");
    expect(c.querySelector('[data-slot="code-editor"]')?.textContent).toBe("one");
    expect(labelled(c, "Load more")).toBeDefined();
  });
});

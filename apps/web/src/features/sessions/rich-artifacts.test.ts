// @vitest-environment happy-dom
import "../../i18n/register-rich-replies.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Translate } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { artifactOf } from "./rich-artifacts.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const t: Translate = (key) => `<${key}>`;
const URL_A = "https://p.example:7778/a/TOKEN/";
const TEXT = "intro\n\n```js\nlet a;\n```\n\n```html\n<b>x</b>\n```\n\n> ```html\n> <i>y</i>\n> ```\n";
const CODE = "<b>x</b>";
const HTML_AT = TEXT.indexOf("```html");
const NESTED_AT = TEXT.indexOf("> ```html") + 2;

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime();
  bed.handlers["previews.artifact"] = () => ({ url: URL_A, until: 1 });
  current.runtime = bed.runtime;
});

describe("artifactOf", () => {
  it("maps the offset of a fence to its index among the top-level fences and mints it", async () => {
    const rich = artifactOf("s1", "e1", TEXT, t);
    expect(rich.canArtifact(HTML_AT, CODE)).toBe(true);
    expect(await rich.artifact(HTML_AT, CODE)).toBe(URL_A);
    const [call] = bed.called("previews.artifact");
    expect(call?.params).toEqual({ sessionId: "s1", entryId: "e1", fenceIndex: 1 });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("a nested fence has no artifact and makes no call", async () => {
    const rich = artifactOf("s1", "e1", TEXT, t);
    expect(rich.canArtifact(NESTED_AT, "<i>y</i>")).toBe(false);
    await expect(rich.artifact(NESTED_AT, "<i>y</i>")).rejects.toThrow();
    expect(bed.called("previews.artifact")).toHaveLength(0);
  });

  // A fence inside a list item renders as the item's code, but the scanner (3 spaces of indent) reads a longer one: the
  // daemon would frame text the owner never saw.
  const SWALLOWED =
    "- a\n\n  ```html\n  <p>shown</p>\nnot in the fence\n\n<script>hidden()</script>\n\n```\n";

  it("fails closed when the scanner's body is not the code the reply shows", async () => {
    const rich = artifactOf("s1", "e1", SWALLOWED, t);
    const at = SWALLOWED.indexOf("```html");
    expect(rich.canArtifact(at, "<p>shown</p>")).toBe(false);
    await expect(rich.artifact(at, "<p>shown</p>")).rejects.toThrow();
    expect(bed.called("previews.artifact")).toHaveLength(0);
  });

  it("a refusal rejects with the app's text for the code", async () => {
    bed.handlers["previews.artifact"] = () => {
      throw new RpcError("limit_reached");
    };
    const rich = artifactOf("s1", "e1", TEXT, t);
    await expect(rich.artifact(HTML_AT, CODE)).rejects.toThrow("<error.limit_reached>");
  });

  it("anything that is not a typed refusal rejects with the internal text", async () => {
    bed.handlers["previews.artifact"] = () => {
      throw new Error("boom");
    };
    const rich = artifactOf("s1", "e1", TEXT, t);
    await expect(rich.artifact(HTML_AT, CODE)).rejects.toThrow("<error.internal>");
  });
});

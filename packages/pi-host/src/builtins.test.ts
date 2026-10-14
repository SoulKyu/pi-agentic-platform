import { beforeEach, describe, expect, it } from "vitest";
import { piBuiltins, signInNotifier } from "./builtins.ts";

describe("piBuiltins", () => {
  const list = piBuiltins({ showSignInLink: () => {} });

  it("registers the three extensions under the exact names, built in and replaceable (M5R24)", () => {
    expect(list.map((extension) => (typeof extension === "function" ? null : extension.name))).toEqual([
      "mcp",
      "codemode",
      "tool-search",
    ]);
    for (const extension of list)
      expect(extension).toMatchObject({ builtin: true, replaceable: true, factory: expect.any(Function) });
  });
});

describe("signInNotifier (M7R31, amended)", () => {
  const sent: Array<[string, string]> = [];
  const show = signInNotifier((message, type) => void sent.push([message, type]));
  beforeEach(() => (sent.length = 0));

  it("tells the owner to paste the redirect address, without repeating the link Pi already shows", () => {
    show("https://auth.example.com/x?state=secret");
    expect(sent).toEqual([
      [
        "MCP sign-in: open the link above in your browser, then paste the address you are sent to into the prompt.",
        "info",
      ],
    ]);
    expect(JSON.stringify(sent)).not.toContain("auth.example.com");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://h/x", "not a url", ""])(
    "says a non-http(s) link %j was not opened and never repeats it",
    (url) => {
      show(url);
      expect(sent).toEqual([
        ["MCP sign-in: the link above is not an http or https address. Do not open it.", "warning"],
      ]);
    },
  );
});

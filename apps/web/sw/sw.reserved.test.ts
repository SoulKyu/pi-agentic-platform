import { describe, expect, it } from "vitest";
import { isNotSpa, routeOf } from "./sw.ts";
import { ORIGIN } from "./harness.ts";

const req = (path: string, mode = "navigate") => ({
  method: "GET",
  mode,
  url: new URL(path, ORIGIN).href,
});

describe("the worker's non-SPA prefixes match the daemon's reserved ones", () => {
  it.each(["/github/app/callback", "/github", "/fonts/inter.woff2", "/fonts"])(
    "never intercepts %s, even as a navigation",
    (path) => {
      expect(isNotSpa(path)).toBe(true);
      expect(routeOf(req(path), ORIGIN)).toBe("pass");
    },
  );

  it("forwards the preview window and other pap routes as same-origin navigations", () => {
    expect(routeOf(req("/preview/project:abc/web"), ORIGIN)).toBe("navigation");
    expect(routeOf(req("/s/abc"), ORIGIN)).toBe("navigation");
    expect(routeOf(req("/fontsy"), ORIGIN)).toBe("navigation");
    expect(routeOf(req("/githubx"), ORIGIN)).toBe("navigation");
  });
});

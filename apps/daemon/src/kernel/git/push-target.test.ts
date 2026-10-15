import { describe, expect, it } from "vitest";
import { pushTarget } from "./push-target.ts";

const GH = "https://github.com/o/r.git";
const run = (originUrls: string[], pushUrls: string[], allowFile = false) =>
  pushTarget({ originUrls, pushUrls, allowFile });

describe("pushTarget (M9R14, M9-RT-02)", () => {
  it("accepts one https URL on both sides", () => {
    expect(run([GH], [GH])).toEqual({ ok: true, target: { host: "github.com", path: "o/r" } });
  });
  it("accepts a same-repository ssh push URL, and a global insteadOf to ssh", () => {
    expect(run([GH], ["git@github.com:o/r.git"])).toMatchObject({ ok: true });
    expect(run(["https://github.com/o/r"], ["ssh://git@github.com/o/r"])).toMatchObject({ ok: true });
  });
  it("refuses a pushurl of another repository or another host", () => {
    expect(run([GH], ["https://github.com/o/other.git"])).toEqual({ ok: false, reason: "repo_config" });
    expect(run([GH], ["https://evil.example/o/r.git"])).toEqual({ ok: false, reason: "repo_config" });
  });
  it("refuses two push URLs, even when both are the same repository", () => {
    expect(run([GH], [GH, "https://evil.example/o/r"])).toEqual({ ok: false, reason: "repo_config" });
    expect(run([GH], [GH, GH])).toEqual({ ok: false, reason: "repo_config" });
  });
  it("refuses two origin URLs", () => {
    expect(run([GH, "https://evil.example/o/r"], [GH])).toEqual({ ok: false, reason: "repo_config" });
  });
  it("no remote when either side is empty", () => {
    expect(run([], [])).toEqual({ ok: false, reason: "no_remote" });
    expect(run([GH], [])).toEqual({ ok: false, reason: "no_remote" });
    expect(run([], [GH])).toEqual({ ok: false, reason: "no_remote" });
  });
  it("a local path or a file origin is unsupported without the seam", () => {
    expect(run(["/srv/remote.git"], ["/srv/remote.git"])).toEqual({
      ok: false,
      reason: "unsupported_remote",
    });
    expect(run(["file:///srv/remote.git"], ["file:///srv/remote.git"])).toEqual({
      ok: false,
      reason: "unsupported_remote",
    });
    expect(run([GH], ["file:///srv/remote.git"])).toEqual({ ok: false, reason: "unsupported_remote" });
  });
  it("under the seam a local path or file URL answers host local", () => {
    expect(run(["/srv/remote.git"], ["/srv/remote.git"], true)).toEqual({
      ok: true,
      target: { host: "local", path: "remote.git" },
    });
    expect(run(["file:///srv/remote.git/"], ["file:///srv/remote.git/"], true)).toEqual({
      ok: true,
      target: { host: "local", path: "remote.git" },
    });
  });
  it("under the seam a forge origin that the owner's global insteadOf rewrote to a local path is accepted (Task 14)", () => {
    expect(run([GH], ["file:///srv/remote.git"], true)).toEqual({
      ok: true,
      target: { host: "local", path: "remote.git" },
    });
  });
  it("the seam needs an origin that is local or a forge URL", () => {
    expect(run(["ftp://example.com/o/r"], ["/srv/remote.git"], true)).toEqual({
      ok: false,
      reason: "repo_config",
    });
    expect(run([GH], ["/srv/remote.git"], false)).toEqual({ ok: false, reason: "unsupported_remote" });
  });
  it("the seam does not excuse a URL that is not local", () => {
    expect(run([GH], ["https://evil.example/o/r"], true)).toEqual({ ok: false, reason: "repo_config" });
  });
});

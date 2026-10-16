import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goodMembers, hasCurrent, installBed, makeRoot, type Member } from "./archive-install-bed.ts";

describe("archive installer, hostile members", () => {
  it.each([
    ["a .. segment", (id: string) => `pap-${id}/../evil`],
    ["another prefix", () => "other-prefix/x"],
    ["an absolute path", (_id: string, root?: string) => `${root}/evil`],
  ])("refuses a member with %s even when its own checksum is pinned", (_label, pick) => {
    const root = makeRoot();
    const bed = installBed("r1", root, {
      members: [...goodMembers("r1"), { name: pick("r1", root.root), data: "pwn" }],
    });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside pap-r1/");
    expect(existsSync(join(root.root, "evil"))).toBe(false);
    expect(hasCurrent(bed.app)).toBe(false);
    expect(readdirSync(join(bed.app, "releases"))).toEqual([]);
  });

  it.each([
    ["an absolute symbolic link", { name: "pap-r1/l", type: "sym", link: "/etc" }],
    ["a symbolic link climbing out", { name: "pap-r1/app/l", type: "sym", link: "../../../x" }],
    ["a symbolic link to the archive root", { name: "pap-r1/l", type: "sym", link: ".." }],
    ["a hard link outside the release", { name: "pap-r1/h", type: "hard", link: "other/x" }],
    ["a hard link climbing out", { name: "pap-r1/h", type: "hard", link: "pap-r1/../x" }],
    ["a fifo", { name: "pap-r1/f", type: "fifo" }],
  ] as [string, Member][])("refuses %s", (_label, member) => {
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", [member]) });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside pap-r1/");
    expect(hasCurrent(bed.app)).toBe(false);
  });

  it("keeps links that stay inside the release", () => {
    const extra: Member[] = [
      { name: "pap-r1/app/a", type: "sym", link: "apps/daemon" },
      { name: "pap-r1/app/up", type: "sym", link: ".." },
      { name: "pap-r1/app/apps/b", type: "sym", link: "../apps/daemon/dist" },
      { name: "pap-r1/app/h", type: "hard", link: "pap-r1/app/apps/daemon/dist/main.js" },
    ];
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", extra) });
    expect(bed.run().status).toBe(0);
    expect(readlinkSync(join(bed.app, "releases/r1/app/a"))).toBe("apps/daemon");
  });

  it("accepts a clean archive whose owner name holds spaces", () => {
    const member: Member = { name: "pap-r1/app/ok", data: "x", owner: "build user" };
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", [member]) });
    expect(bed.run().status).toBe(0);
  });

  it.each([
    [
      "a hard link that turns into a shallower copy of a deep ..-chain link",
      [
        { name: "pap-r1/a/", type: "dir" },
        { name: "pap-r1/a/b/", type: "dir" },
        { name: "pap-r1/a/b/c/", type: "dir" },
        { name: "pap-r1/a/b/c/l", type: "sym", link: "../../.." },
        { name: "pap-r1/h", type: "hard", link: "pap-r1/a/b/c/l" },
      ],
    ],
    [
      "the same inside a folder that is mode 0100 (find cannot read it until modes are opened)",
      [
        { name: "pap-r1/a/", type: "dir" },
        { name: "pap-r1/a/b/", type: "dir" },
        { name: "pap-r1/a/b/c/", type: "dir" },
        { name: "pap-r1/a/b/c/l", type: "sym", link: "../../.." },
        { name: "pap-r1/X/", type: "dir", mode: 0o100 },
        { name: "pap-r1/X/h", type: "hard", link: "pap-r1/a/b/c/l" },
      ],
    ],
  ] as [string, Member[]][])("refuses %s", (_label, extra) => {
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", extra) });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the archive holds a link that points outside pap-r1/");
    expect(result.stderr).not.toContain("Permission denied");
    expect(hasCurrent(bed.app)).toBe(false);
  });

  it("refuses a link that only escapes once an earlier symbolic link is followed", () => {
    const extra: Member[] = [
      { name: "pap-r1/app/s", type: "sym", link: ".." },
      { name: "pap-r1/app/s/q", type: "sym", link: "../../x" },
    ];
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", extra) });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(hasCurrent(bed.app)).toBe(false);
    expect(result.stderr).toMatch(/points outside pap-r1\/|could not extract/);
  });

  it("refuses an escaping symlink whose owner name holds spaces (listing columns cannot shift)", () => {
    const member: Member = { name: "pap-r1/l", type: "sym", link: "/etc", owner: "evil user x y" };
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", [member]) });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside pap-r1/");
    expect(hasCurrent(bed.app)).toBe(false);
  });

  it.each([
    ["in the name", { name: "pap-r1/s -> t", type: "sym", link: "/etc" }],
    ["in the target", { name: "pap-r1/s", type: "sym", link: "t -> /etc" }],
    [
      "of a hard link in the name",
      { name: "pap-r1/h link to x", type: "hard", link: "pap-r1/node/bin/node" },
    ],
  ] as [string, Member][])("refuses a link marker %s", (_label, member) => {
    const bed = installBed("r1", makeRoot(), { members: goodMembers("r1", [member]) });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside pap-r1/");
    expect(hasCurrent(bed.app)).toBe(false);
  });

  it("refuses a release folder that is a symbolic link, even when the checks inside pass", () => {
    const first: Member = { name: "pap-r1/", type: "sym", link: "." };
    const members: Member[] = [first, ...goodMembers("r1").slice(1)].filter(
      (m) => !m.name.endsWith("/") || m.name === "pap-r1/",
    );
    const bed = installBed("r1", makeRoot(), { members });
    const result = bed.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a plain folder|could not extract/);
    expect(hasCurrent(bed.app)).toBe(false);
    expect(readdirSync(join(bed.app, "releases"))).toEqual([]);
  });
});

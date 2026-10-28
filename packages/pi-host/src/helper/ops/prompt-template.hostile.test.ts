import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelperOpError } from "../ops.ts";
import { writeTemplate } from "./prompt-template.ts";

let root: string;
let agentDir: string;
let folder: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-tpl-h-"));
  agentDir = join(root, "agent");
  folder = join(agentDir, "prompts");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : `other:${String(error)}`),
  );
const save = (replace?: boolean, hooks?: Parameters<typeof writeTemplate>[2]) =>
  writeTemplate(
    { agentDir },
    { name: "review", body: "new\n", ...(replace === undefined ? {} : { replace }) },
    hooks,
  );

describe("writeTemplate against a hostile folder", () => {
  it("an existing name answers conflict and leaves the file byte for byte, with no temporary file left", async () => {
    writeFileSync(join(folder, "review.md"), "mine\n");
    expect(await codeOf(save())).toBe("conflict");
    expect(readFileSync(join(folder, "review.md"), "utf8")).toBe("mine\n");
    expect(readdirSync(folder)).toEqual(["review.md"]);
  });

  it("replace swaps the file: a new inode, 0600, replaced true", async () => {
    const file = join(folder, "review.md");
    writeFileSync(file, "mine\n", { mode: 0o644 });
    const before = statSync(file).ino;
    expect(await save(true)).toEqual({ replaced: true });
    expect(statSync(file).ino).not.toBe(before);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("new\n");
    expect(readdirSync(folder)).toEqual(["review.md"]);
  });

  it("a prompts folder that is a link to elsewhere is refused config_path_refused and nothing is written there", async () => {
    rmSync(folder, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, folder);
    expect(await codeOf(save())).toBe("config_path_refused");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a target linked to ../settings.json answers conflict without replace and config_path_refused with it; settings.json is unchanged and the link is still a link", async () => {
    writeFileSync(join(agentDir, "settings.json"), '{"a":1}');
    symlinkSync("../settings.json", join(folder, "review.md"));
    expect(await codeOf(save())).toBe("conflict");
    expect(await codeOf(save(true))).toBe("config_path_refused");
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe('{"a":1}');
    expect(lstatSync(join(folder, "review.md")).isSymbolicLink()).toBe(true);
    expect(readdirSync(folder)).toEqual(["review.md"]);
  });

  it("a directory target is refused with replace", async () => {
    mkdirSync(join(folder, "review.md"));
    expect(await codeOf(save(true))).toBe("config_path_refused");
    expect(lstatSync(join(folder, "review.md")).isDirectory()).toBe(true);
  });

  it("a hard-linked target answers config_hard_link with replace; the other name keeps its text", async () => {
    writeFileSync(join(agentDir, "auth.json"), "secret");
    linkSync(join(agentDir, "auth.json"), join(folder, "review.md"));
    expect(await codeOf(save(true))).toBe("config_hard_link");
    expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe("secret");
    expect(readFileSync(join(folder, "review.md"), "utf8")).toBe("secret");
    expect(readdirSync(folder)).toEqual(["review.md"]);
  });

  it("a name created between the check and the write answers conflict and keeps the planted file", async () => {
    const planted = join(folder, "review.md");
    const code = await codeOf(
      save(undefined, {
        lstat: async () => {
          writeFileSync(planted, "planted\n");
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
      }),
    );
    expect(code).toBe("conflict");
    expect(readFileSync(planted, "utf8")).toBe("planted\n");
    expect(readdirSync(folder)).toEqual(["review.md"]);
  });
});

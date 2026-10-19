import {
  linkSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  renameSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickPackages, seedAgentFolder } from "./seed.ts";

let dir: string;
let layout: VmLayout;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-seed-"));
  const root = join(dir, "agent");
  mkdirSync(root);
  layout = {
    root,
    home: join(root, "home"),
    knowledge: join(root, "knowledge"),
    inbox: join(root, "inbox"),
    pi: join(root, ".pi"),
    sessions: join(root, ".pi", "sessions"),
    piAgentDir: join(root, ".pi", "agent"),
    imageAgentDir: join(dir, "image"),
    shellOverlay: join(dir, "overlay"),
  };
  mkdirSync(layout.imageAgentDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string): number => statSync(path).mode & 0o777;
const writeImage = (name: string, text: string): void => {
  mkdirSync(join(layout.imageAgentDir, name, ".."), { recursive: true });
  writeFileSync(join(layout.imageAgentDir, name), text);
};

describe("seedAgentFolder links (AVM-E26)", () => {
  // Mutant: the link branch left out -> "keeps a link" fails; the inside check removed -> "refuses" fails.
  it("keeps a link whose target stays inside the image as a relative link", () => {
    writeImage("npm/pkg/lib/a.js", "a");
    symlinkSync("lib/a.js", join(layout.imageAgentDir, "npm/pkg/link"));
    seedAgentFolder(layout);
    const seeded = join(layout.piAgentDir, "npm/pkg/link");
    expect(lstatSync(seeded).isSymbolicLink()).toBe(true);
    expect(readlinkSync(seeded)).toBe("lib/a.js");
    expect(readFileSync(seeded, "utf8")).toBe("a");
  });

  it("refuses a link that leaves the image and one that dangles", () => {
    writeFileSync(join(dir, "elsewhere"), "x");
    symlinkSync(join(dir, "elsewhere"), join(layout.imageAgentDir, "out"));
    expect(() => seedAgentFolder(layout)).toThrow(/leaves the image/);
    rmSync(join(layout.imageAgentDir, "out"));
    symlinkSync("missing", join(layout.imageAgentDir, "gone"));
    expect(() => seedAgentFolder(layout)).toThrow(/does not resolve/);
  });

  it("replaces a link or file the disk holds under an image link's name, never writing through it", () => {
    writeImage("a.js", "a");
    symlinkSync("a.js", join(layout.imageAgentDir, "l"));
    mkdirSync(layout.piAgentDir, { recursive: true });
    writeFileSync(join(dir, "victim"), "keep");
    symlinkSync(join(dir, "victim"), join(layout.piAgentDir, "l"));
    seedAgentFolder(layout);
    expect(readlinkSync(join(layout.piAgentDir, "l"))).toBe("a.js");
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("keep");
  });
});

describe("seedAgentFolder", () => {
  it("makes the layout folders of a blank disk (AVM-P5)", () => {
    seedAgentFolder(layout);
    for (const folder of [layout.home, layout.knowledge, layout.inbox]) expect(mode(folder)).toBe(0o755);
    for (const folder of [layout.pi, layout.sessions, layout.piAgentDir]) expect(mode(folder)).toBe(0o700);
  });

  it("keeps what a folder already holds and its mode", () => {
    mkdirSync(layout.home);
    writeFileSync(join(layout.home, "notes.txt"), "mine");
    chmodSync(layout.home, 0o750);
    seedAgentFolder(layout);
    expect(readFileSync(join(layout.home, "notes.txt"), "utf8")).toBe("mine");
    expect(mode(layout.home)).toBe(0o750);
  });

  // Mutant: create the folder through a followed path -> the link is entered and the outside folder is filled (killed).
  it("refuses a link in place of a layout folder", () => {
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), layout.knowledge);
    expect(() => seedAgentFolder(layout)).toThrow(/not a folder/);
    expect(existsSync(join(dir, "outside", ".pi"))).toBe(false);
  });

  it("refuses a file in place of a layout folder", () => {
    writeFileSync(layout.inbox, "x");
    expect(() => seedAgentFolder(layout)).toThrow(/not a folder/);
  });

  it("refuses a link in place of Pi's agent folder, and one in place of .pi", () => {
    mkdirSync(join(dir, "outside"));
    mkdirSync(layout.pi);
    symlinkSync(join(dir, "outside"), layout.piAgentDir);
    writeImage("settings.json", "{}");
    expect(() => seedAgentFolder(layout)).toThrow(/not a folder/);
    expect(existsSync(join(dir, "outside", "settings.json"))).toBe(false);
    rmSync(layout.pi, { recursive: true });
    symlinkSync(join(dir, "outside"), layout.pi);
    expect(() => seedAgentFolder(layout)).toThrow(/not a folder/);
    expect(existsSync(join(dir, "outside", "agent"))).toBe(false);
  });

  it("refuses a root that is a link", () => {
    rmSync(layout.root, { recursive: true });
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), layout.root);
    expect(() => seedAgentFolder(layout)).toThrow();
  });

  it("copies the image files, nested ones included, with a private mode", () => {
    writeImage("settings.json", '{"a":1}');
    writeImage("skills/one/SKILL.md", "skill");
    seedAgentFolder(layout);
    expect(readFileSync(join(layout.piAgentDir, "settings.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(layout.piAgentDir, "skills/one/SKILL.md"), "utf8")).toBe("skill");
    expect(mode(join(layout.piAgentDir, "settings.json")) & 0o077).toBe(0);
    expect(mode(join(layout.piAgentDir, "skills"))).toBe(0o700);
  });

  it("replaces an image file the worker changed and keeps a file only the worker made", () => {
    writeImage("settings.json", "image");
    seedAgentFolder(layout);
    writeFileSync(join(layout.piAgentDir, "settings.json"), "the worker changed this and it is longer");
    writeFileSync(join(layout.piAgentDir, "auth.json"), "pi state");
    writeFileSync(join(layout.sessions, "s.jsonl"), "session");
    seedAgentFolder(layout);
    expect(readFileSync(join(layout.piAgentDir, "settings.json"), "utf8")).toBe("image");
    expect(readFileSync(join(layout.piAgentDir, "auth.json"), "utf8")).toBe("pi state");
    expect(readFileSync(join(layout.sessions, "s.jsonl"), "utf8")).toBe("session");
  });

  // Mutant: open the destination without O_NOFOLLOW -> the image file is written through the planted link (killed).
  it("refuses a link planted where an image file goes and writes nothing through it", () => {
    writeImage("settings.json", "image");
    seedAgentFolder(layout);
    writeFileSync(join(dir, "victim"), "untouched");
    rmSync(join(layout.piAgentDir, "settings.json"));
    symlinkSync(join(dir, "victim"), join(layout.piAgentDir, "settings.json"));
    expect(() => seedAgentFolder(layout)).toThrow();
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("untouched");
  });

  it("refuses a link planted in place of a nested folder", () => {
    writeImage("skills/one/SKILL.md", "skill");
    seedAgentFolder(layout);
    mkdirSync(join(dir, "outside"));
    rmSync(join(layout.piAgentDir, "skills"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(layout.piAgentDir, "skills"));
    expect(() => seedAgentFolder(layout)).toThrow(/not a folder/);
    expect(existsSync(join(dir, "outside", "one"))).toBe(false);
  });

  it("refuses an image link to an absolute path outside the image, writing nothing through it", () => {
    writeImage("settings.json", "image");
    symlinkSync("/etc/passwd", join(layout.imageAgentDir, "passwd"));
    expect(() => seedAgentFolder(layout)).toThrow(/leaves the image/);
    expect(existsSync(join(layout.piAgentDir, "passwd"))).toBe(false);
  });
});

describe("pickPackages", () => {
  const imageSettings = {
    theme: "dark",
    packages: ["npm:a@1.0.0", { source: "npm:b@1.0.0", extensions: ["x"] }, "npm:c@1.0.0"],
  };
  const seeded = (): void => {
    writeImage("settings.json", JSON.stringify(imageSettings));
    seedAgentFolder(layout);
  };
  const written = (): { theme?: string; extra?: number; packages?: unknown[] } =>
    JSON.parse(readFileSync(join(layout.piAgentDir, "settings.json"), "utf8"));

  it("keeps the image's entries whose source the agent picked, objects included", () => {
    seeded();
    pickPackages(layout, ["npm:c@1.0.0", "npm:b@1.0.0"]);
    expect(written().packages).toEqual([imageSettings.packages[1], "npm:c@1.0.0"]);
    expect(written().theme).toBe("dark");
  });

  it("leaves every package for null", () => {
    seeded();
    pickPackages(layout, null);
    expect(written().packages).toEqual(imageSettings.packages);
  });

  it("writes an empty list for an empty pick and ignores a pick the image does not hold", () => {
    seeded();
    pickPackages(layout, ["npm:zzz@9.9.9"]);
    expect(written().packages).toEqual([]);
  });

  it("narrows from the image's list each time and keeps Pi's other keys", () => {
    seeded();
    writeFileSync(
      join(layout.piAgentDir, "settings.json"),
      JSON.stringify({ ...imageSettings, extra: 1, packages: ["npm:a@1.0.0"] }),
    );
    pickPackages(layout, ["npm:c@1.0.0"]);
    expect(written().packages).toEqual(["npm:c@1.0.0"]);
    expect(written().extra).toBe(1);
  });

  // Mutant: open settings.json without O_NOFOLLOW -> the picks are written through the link (killed).
  it("refuses a settings.json that is a link", () => {
    seeded();
    writeFileSync(join(dir, "victim"), "untouched");
    rmSync(join(layout.piAgentDir, "settings.json"));
    symlinkSync(join(dir, "victim"), join(layout.piAgentDir, "settings.json"));
    expect(() => pickPackages(layout, ["npm:a@1.0.0"])).toThrow();
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("untouched");
  });

  // Mutant: pickPackages opens piAgentDir by its full path -> the link at `.pi` is followed (killed).
  it("refuses a link at a middle component of Pi's agent folder path", () => {
    seeded();
    mkdirSync(join(dir, "elsewhere", "agent"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "agent", "settings.json"), "{}");
    renameSync(layout.pi, join(dir, "moved"));
    symlinkSync(join(dir, "elsewhere"), layout.pi);
    expect(() => pickPackages(layout, ["npm:a@1.0.0"])).toThrow();
    expect(readFileSync(join(dir, "elsewhere", "agent", "settings.json"), "utf8")).toBe("{}");
  });

  // Mutant: write settings.json in place (O_TRUNC) -> a hard link made earlier changes too; a temp file stays behind.
  it("replaces settings.json by rename and leaves no temporary file", () => {
    seeded();
    const settings = join(layout.piAgentDir, "settings.json");
    linkSync(settings, join(dir, "old-copy"));
    const before = readFileSync(settings, "utf8");
    pickPackages(layout, ["npm:c@1.0.0"]);
    expect(readFileSync(join(dir, "old-copy"), "utf8")).toBe(before);
    expect(readdirSync(layout.piAgentDir).filter((name) => name.includes("settings"))).toEqual([
      "settings.json",
    ]);
  });
});

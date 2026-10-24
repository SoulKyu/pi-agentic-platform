import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBoxPaths, type VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KATA_PROJECT_LAYOUT } from "./kata-layout.ts";
import { seedAgentFolder } from "./seed.ts";

let dir: string;
let layout: VmLayout;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-seed-project-"));
  const paths = projectBoxPaths(join(dir, "box"));
  mkdirSync(paths.root);
  mkdirSync(join(dir, "image"));
  layout = {
    ...paths,
    knowledge: `${paths.project}/knowledge`,
    imageAgentDir: join(dir, "image"),
    shellOverlay: join(dir, "overlay"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("seedAgentFolder for a project box", () => {
  it("inits git in an empty project once and never re-inits", () => {
    const told: string[] = [];
    seedAgentFolder(layout, (line) => told.push(line));
    const head = join(layout.project as string, ".git", "HEAD");
    expect(readFileSync(head, "utf8")).toBe("ref: refs/heads/main\n");
    writeFileSync(head, "ref: refs/heads/mine\n");
    seedAgentFolder(layout, (line) => told.push(line));
    expect(readFileSync(head, "utf8")).toBe("ref: refs/heads/mine\n");
    expect(told).toEqual([]);
  });

  it("seeds home, inbox and .pi and no knowledge folder in a project", () => {
    seedAgentFolder(layout);
    for (const folder of [layout.home, layout.inbox, layout.sessions, layout.piAgentDir])
      expect(lstatSync(folder).isDirectory(), folder).toBe(true);
    expect(existsSync(layout.knowledge)).toBe(false);
    expect(existsSync(join(layout.root, "knowledge"))).toBe(false);
  });

  it("leaves a project that has a .git (a link too) alone", () => {
    mkdirSync(layout.project as string);
    writeFileSync(join(layout.project as string, ".git"), "gitdir: /elsewhere\n");
    seedAgentFolder(layout);
    expect(readFileSync(join(layout.project as string, ".git"), "utf8")).toBe("gitdir: /elsewhere\n");
  });
});

describe("KATA_PROJECT_LAYOUT", () => {
  it("mounts at /boxes/<id> with the agents' image folder", () => {
    const id = "0b9f3a52-0f6b-4f4e-8d57-2b4a0c8a9f10";
    expect(KATA_PROJECT_LAYOUT(id)).toEqual({
      root: `/boxes/${id}`,
      project: `/boxes/${id}/project`,
      home: `/boxes/${id}/home`,
      inbox: `/boxes/${id}/inbox`,
      pi: `/boxes/${id}/.pi`,
      sessions: `/boxes/${id}/.pi/sessions`,
      piAgentDir: `/boxes/${id}/.pi/agent`,
      knowledge: `/boxes/${id}/project/knowledge`,
      imageAgentDir: "/opt/pap/pi-agent",
      shellOverlay: "/run/pap-shell",
    });
  });
});

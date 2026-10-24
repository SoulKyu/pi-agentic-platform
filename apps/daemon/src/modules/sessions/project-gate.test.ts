import { DEFAULT_PROJECT_RESOURCES, type VmLayout } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { ProjectBoxRow } from "../../kernel/boxes.ts";
import { projectLayoutOf } from "../agent-vm/index.ts";
import { projectGate, type SessionBoxes } from "./project-gate.ts";
import type { SessionRow } from "./store.ts";
import type { VmGateFs } from "./vm-gate.ts";

const ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const layout = projectLayoutOf("process", "/pap", ID);
const box = (extra: Partial<ProjectBoxRow> = {}): ProjectBoxRow => ({
  ownerId: "u1",
  root: layout.project ?? "",
  resources: DEFAULT_PROJECT_RESOURCES,
  hosts: [],
  deleting: false,
  ...extra,
});
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: "s1", ownerId: "u1", cwd: layout.project, piPath: null, ...extra }) as SessionRow;
/** A file system that makes folders in memory: the gate's only host calls, recorded. */
function memoryFs(existing: Record<string, { dir?: boolean; link?: boolean; uid?: number }> = {}) {
  const made: string[] = [];
  const fs: VmGateFs = {
    lstat: (path) => {
      const found = existing[path];
      return found
        ? {
            isDirectory: () => found.dir !== false,
            isSymbolicLink: () => found.link === true,
            uid: found.uid ?? process.getuid?.() ?? 0,
          }
        : null;
    },
    mkdir: (path, mode) => void made.push(`${path} ${mode.toString(8)}`),
  };
  return { fs, made };
}
const gate = (
  found: ProjectBoxRow | null,
  r: SessionRow = row(),
  vmLayout: VmLayout | null = layout,
  fs: VmGateFs = memoryFs().fs,
) => {
  const boxes: SessionBoxes = {
    projectOf: () => ID,
    box: () => found,
    claudeTokenSet: () => false,
    addHost: () => undefined,
  };
  return projectGate(r, { boxes, vmLayoutOf: () => vmLayout, papHome: "/pap", fs });
};

describe("projectGate", () => {
  it("answers the box's resources and the project folder as the scope", () => {
    expect(gate(box())).toEqual({
      project: { id: ID },
      resources: DEFAULT_PROJECT_RESOURCES,
      scope: layout.project,
      home: layout.home,
      vm: true,
    });
  });
  it("is null for a row that is in no box", () => {
    const boxes: SessionBoxes = {
      projectOf: () => null,
      box: () => box(),
      claudeTokenSet: () => false,
      addHost: () => undefined,
    };
    expect(
      projectGate(row(), { boxes, vmLayoutOf: () => null, papHome: "/pap", fs: memoryFs().fs }),
    ).toBeNull();
  });
  it("refuses a deleting project and another owner's project", () => {
    expect(() => gate(box({ deleting: true }))).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => gate(box({ ownerId: "u2" }))).toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("refuses a box the source no longer holds", () => {
    expect(() => gate(null)).toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("fails closed when the row has no project layout", () => {
    expect(() => gate(box(), row(), null)).toThrow(expect.objectContaining({ code: "sandbox_unavailable" }));
  });
  it("makes the project's mirror folder 0700 under boxes/.mirrors, and no folder of the box on the host", () => {
    const { fs, made } = memoryFs();
    gate(box(), row(), layout, fs);
    expect(made).toEqual(["/pap/boxes 700", "/pap/boxes/.mirrors 700", `/pap/boxes/.mirrors/${ID} 700`]);
  });
  it("keeps the folders that exist, and refuses a link or a file in their place with invalid_cwd", () => {
    const mirrors = `/pap/boxes/.mirrors/${ID}`;
    const kept = memoryFs({ "/pap/boxes": {}, "/pap/boxes/.mirrors": {}, [mirrors]: {} });
    gate(box(), row(), layout, kept.fs);
    expect(kept.made).toEqual([]);
    for (const bad of [{ link: true }, { dir: false }, { uid: -1 }])
      expect(() => gate(box(), row(), layout, memoryFs({ [mirrors]: bad }).fs)).toThrow(
        expect.objectContaining({ code: "invalid_cwd" }),
      );
  });
  it("makes nothing for a refused launch", () => {
    const { fs, made } = memoryFs();
    expect(() => gate(box({ deleting: true }), row(), layout, fs)).toThrow();
    expect(made).toEqual([]);
  });
});

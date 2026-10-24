import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layout, SLOT, start } from "../testing/guest-harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const projectLayout = () => {
  const project = mkdtempSync(join(tmpdir(), "pap-guest-pty-"));
  dirs.push(project);
  return { ...layout, project };
};
const ptyOpen = (cwd: string) => ({ type: "pty_open", slot: SLOT, cols: 80, rows: 24, cwd });

describe("runGuest pty_open", () => {
  it("reports a slot whose folder is outside the project as exited, and opens no connection", async () => {
    const run = await start({ layout: projectLayout() });
    await run.hello();
    run.gateway.send(ptyOpen("/etc"));
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual({
        type: "exited",
        slot: SLOT,
        code: 1,
        signal: null,
        tail: "pap-guest: the folder is not in the project",
      }),
    );
  });

  it("reports terminal_unavailable when node-pty cannot load, and keeps running", async () => {
    const withProject = projectLayout();
    const run = await start({ layout: withProject, loadPty: () => null });
    await run.hello();
    run.gateway.send(ptyOpen(withProject.project as string));
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual(
        expect.objectContaining({ type: "exited", slot: SLOT, tail: "pap-guest: terminal_unavailable" }),
      ),
    );
    expect(run.exits).toEqual([]);
  });

  it("an agent's VM, which has no project folder, refuses every pty_open", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send(ptyOpen("/agent/home"));
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual(expect.objectContaining({ type: "exited", slot: SLOT })),
    );
  });
});

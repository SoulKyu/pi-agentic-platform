import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostBed, isApproval } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

const within = { timeout: 20_000 };
const ON = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });
// pnpm puts a relative `./node_modules/.bin` in PATH; a relative entry is never covered.
const PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => entry.startsWith("/"))
  .join(":");
const CLEAN = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";

/** The session folder is inside a clean repository made by hand, as in a real project (MC18). */
function sessionRepo(): void {
  const git = join(bed.cwd, ".git");
  mkdirSync(join(git, "objects"), { recursive: true });
  mkdirSync(join(git, "refs"));
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "config"), CLEAN);
}

/** A hook that leaves a marker, and the config of a bare layout that runs it and gives itself a work tree. */
function plant(): { marker: string; config: string } {
  const marker = join(bed.cwd, "ran.marker");
  const hook = join(bed.cwd, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  return { marker, config: `${CLEAN}\tworktree = ..\n\tfsmonitor = ${hook}\n` };
}

function bareLayout(config: string): void {
  const hm = join(bed.cwd, "hm");
  mkdirSync(join(hm, "objects"), { recursive: true });
  mkdirSync(join(hm, "refs"));
  writeFileSync(join(hm, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(hm, "config"), config);
}

describe("pi-host worker: bare repositories are never discovered (MC18)", () => {
  it("control: plain git, without the pin, runs the planted program from the same layout", () => {
    sessionRepo();
    const { marker, config } = plant();
    bareLayout(config);
    const env = { PATH, HOME: bed.home, LANG: "C.UTF-8" };
    execFileSync("git", ["-C", join(bed.cwd, "hm"), "status"], { env, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
  });

  it("the agent's git ignores the planted bare layout, even when the owner allows the command", async () => {
    sessionRepo();
    const { marker, config } = plant();
    bareLayout(config);
    await bed.start(
      {
        steps: [
          { toolCalls: [{ name: "bash", args: { command: "git -C hm status" }, id: "g1" }] },
          { text: "done" },
        ],
      },
      { env: { PATH }, policy: ON },
    );
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({ tool: "bash", toolCallId: "g1" });
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "tool_execution_end");
    expect(existsSync(marker)).toBe(false);
  });

  it("one message that writes a bare layout into an empty folder and runs git there never runs the program", async () => {
    sessionRepo();
    const { marker, config } = plant();
    const file = (name: string, content: string, id: string) => ({
      name: "write",
      args: { path: join(bed.cwd, "hm", name), content },
      id,
    });
    mkdirSync(join(bed.cwd, "hm"));
    await bed.start(
      {
        steps: [
          {
            toolCalls: [
              file("HEAD", "ref: refs/heads/main\n", "w1"),
              file("config", config, "w2"),
              file("objects/.keep", "", "w3"),
              file("refs/.keep", "", "w4"),
              { name: "bash", args: { command: "git -C hm status" }, id: "g1" },
            ],
          },
          { text: "done" },
        ],
      },
      { env: { PATH }, policy: ON },
    );
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    await vi.waitFor(
      () => expect(host.records.filter((r) => r.type === "tool_execution_end")).toHaveLength(5),
      within,
    );
    expect(existsSync(join(bed.cwd, "hm", "config"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to start when GIT_CONFIG_COUNT is not a number", async () => {
    const host = bed.launch({ steps: [] }, { env: { PATH, GIT_CONFIG_COUNT: "many" } });
    await vi.waitFor(() => expect(host.stderr()).toContain("GIT_CONFIG_COUNT"), within);
    await host.exited;
  });
});

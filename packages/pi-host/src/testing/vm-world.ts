import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts";

/** A temporary VM layout (`<base>/agent/...`): the agent's three folders, Pi's `.pi` with a transcript, a skills folder. */
export function makeVmWorld(options: { piAgentDir?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-vm-world-")));
  const root = join(base, "agent");
  const layout: VmLayout = {
    root,
    home: join(root, "home"),
    knowledge: join(root, "knowledge"),
    inbox: join(root, "inbox"),
    pi: join(root, ".pi"),
    sessions: join(root, ".pi", "sessions"),
    piAgentDir: options.piAgentDir ?? join(root, ".pi", "agent"),
    imageAgentDir: join(base, "image-agent"),
    shellOverlay: join(base, "run-pap-shell"),
  };
  for (const dir of [
    layout.home,
    layout.knowledge,
    layout.inbox,
    layout.sessions,
    join(layout.piAgentDir, "skills"),
  ])
    mkdirSync(dir, { recursive: true });
  const transcript = join(layout.sessions, "s.jsonl");
  writeFileSync(transcript, "TRANSCRIPT\n");
  writeFileSync(join(layout.piAgentDir, "skills", "k.md"), "skill\n");
  return { base, layout, transcript, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

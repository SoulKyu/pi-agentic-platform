import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { AGENT_PROMPT_LIMITS, AgentPromptName, type Caller, PapError } from "@pap/contracts";
import { agentHomeOf } from "../sessions/index.ts";
import type { AgentStore } from "./store.ts";

export interface PromptsDeps {
  readonly store: Pick<AgentStore, "get">;
  readonly papHome: string;
  /** The agent runs in a VM: its chips are not read from the host home (R16). */
  runsInVm?(ownerId: string, agentId: string): boolean;
}

/** Entries of the prompts folder looked at by one list; the rest are not chips. */
export const PROMPT_SCAN_MAX = 256;

const uid = (): number | undefined => process.getuid?.();

/**
 * The prompt chips (M11R186): the `.md` files directly under `<home>/prompts/`. The home is agent-writable (a tainted
 * thread may have written any of it), so nothing is followed: every entry is `lstat`ed, a link is skipped, and a read opens
 * with `O_NOFOLLOW` and then checks that the descriptor really is that file. The text is data for the composer, never a
 * prompt pap sends.
 */
export function createPrompts(deps: PromptsDeps) {
  /** The agent's real home (`invalid_cwd` for a link or a foreign folder), and its prompts folder when that is a real folder. */
  function folderOf(ownerId: string, agentId: string): { home: string; prompts: string | null } {
    if (!deps.store.get(ownerId, agentId)) throw new PapError("not_found");
    const home = agentHomeOf(deps.papHome, agentId);
    const prompts = join(home, "prompts");
    try {
      const stat = lstatSync(prompts);
      if (!stat.isDirectory() || stat.uid !== uid() || realpathSync(prompts) !== prompts)
        return { home, prompts: null };
    } catch {
      return { home, prompts: null };
    }
    return { home, prompts };
  }

  return {
    list(caller: Caller, agentId: string): { names: string[] } {
      const { prompts } = folderOf(caller.userId, agentId);
      if (prompts === null || deps.runsInVm?.(caller.userId, agentId)) return { names: [] };
      // At most PROMPT_SCAN_MAX entries are looked at: a folder an agent filled cannot make the read long.
      const entries: string[] = [];
      try {
        const dir = opendirSync(prompts);
        try {
          for (
            let entry = dir.readSync();
            entry !== null && entries.length < PROMPT_SCAN_MAX;
            entry = dir.readSync()
          )
            entries.push(entry.name);
        } finally {
          dir.closeSync();
        }
      } catch {
        return { names: [] };
      }
      const names: string[] = [];
      for (const name of entries.sort()) {
        if (names.length >= AGENT_PROMPT_LIMITS.names) break;
        if (!AgentPromptName.safeParse(name).success) continue;
        try {
          const stat = lstatSync(join(prompts, name));
          if (stat.isFile() && stat.uid === uid()) names.push(name);
        } catch {
          // Gone between the listing and the check: not a chip.
        }
      }
      // The folder itself was swapped for a link while it was read: the answer is not trusted.
      return folderOf(caller.userId, agentId).prompts === prompts ? { names } : { names: [] };
    },

    read(caller: Caller, agentId: string, name: string): { text: string } {
      const { prompts } = folderOf(caller.userId, agentId);
      if (!AgentPromptName.safeParse(name).success) throw new PapError("bad_request");
      if (prompts === null || deps.runsInVm?.(caller.userId, agentId)) throw new PapError("not_found");
      const path = join(prompts, name);
      let fd: number;
      try {
        // O_NONBLOCK: a pipe planted under a chip's name must not hang the daemon.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        throw new PapError("not_found");
      }
      try {
        const stat = fstatSync(fd);
        // `/proc/self/fd` names the file the descriptor is: a folder swapped for a link in the path leads elsewhere.
        if (!stat.isFile() || stat.uid !== uid() || readlinkSync(`/proc/self/fd/${fd}`) !== path)
          throw new PapError("not_found");
        if (stat.size > AGENT_PROMPT_LIMITS.bytes) throw new PapError("payload_too_large");
        const buffer = Buffer.alloc(AGENT_PROMPT_LIMITS.bytes + 1);
        let length = 0;
        for (;;) {
          const got = readSync(fd, buffer, length, buffer.length - length, null);
          if (got === 0) break;
          length += got;
          if (length > AGENT_PROMPT_LIMITS.bytes) throw new PapError("payload_too_large");
        }
        try {
          return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)) };
        } catch {
          throw new PapError("bad_request");
        }
      } finally {
        closeSync(fd);
      }
    },
  };
}
export type Prompts = ReturnType<typeof createPrompts>;

import { DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Statfs } from "../../kernel/disk.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createProvenance, promptHash, type Provenance, userTextOf } from "./mirror-line.ts";
import { createKeepSweeper } from "./mirror-keep.ts";
import { createLineParser, type LineParser } from "./mirror-parse.ts";
import { mirrorFileOf, type MirrorRow, mirrorPathOf, projectMirrorPathOf } from "./mirror-paths.ts";
import { createQuota, QUOTA_NOTICE } from "./mirror-quota.ts";
import { FILE_LOST_NOTICE, openMirror, REPLACED_NOTICE } from "./mirror.ts";
import type { MirrorPort, WorkerSpawnInput } from "./vm-worker.ts";

const MIB = 1024 * 1024;
/** Sessions whose sent texts are remembered; the oldest is forgotten past this (the texts are bounded per session, R32). */
const MAX_PROVENANCES = 512;
const MAX_DEFERRED = 64;

/** What a mirror says to a session: the notice, the taint, and whether the database may be written now (RT-42). */
export interface MirrorHooks {
  /**
   * `now`: no start of the session follows (its launch is failing), so a notice held for the next start would not come: it is shown
   * to whoever watches the session at once.
   */
  notice(sessionId: string, text: string, now?: true): void;
  taint(sessionId: string): void;
  canWrite(): boolean;
}

export interface MirrorInputsDeps extends MirrorHooks {
  readonly papHome: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `PAP_MIN_FREE_DISK_MB`: no append while `$PAP_HOME` has less free space (0 = off). */
  readonly minFreeDiskMb: number;
  readonly statfs?: Statfs;
  /** Tests: the parse thread. */
  readonly parser?: LineParser;
}

/** The row facts a mirror needs (structural: the sessions store's row has more). */
export type MirrorInputRow = MirrorRow & { readonly id: string };

export interface MirrorInputs {
  /** The worker input of a session: where its mirror is, how it opens it, and where sent prompts are recorded. */
  inputFor(row: MirrorInputRow, resources?: { readonly diskMb: number }): WorkerSpawnInput;
  /** Starts the sweep of the kept copies (R14). */
  start(): void;
  close(): void;
}

/** T9b: the daemon's mirrors of the VM session files (R23), one input per session row. */
export function createMirrorInputs(deps: MirrorInputsDeps): MirrorInputs {
  const { papHome, clock, logger } = deps;
  const parser = deps.parser ?? createLineParser({ clock, logger });
  const quota = createQuota({
    papHome,
    clock,
    minFreeMb: deps.minFreeDiskMb,
    ...(deps.statfs === undefined ? {} : { statfs: deps.statfs }),
  });
  const sweeper = createKeepSweeper({
    papHome,
    clock,
    logger,
    onSwept: (agents) => agents.forEach((agent) => quota.forget(agent)),
  });
  const provenances = new Map<string, Provenance>();
  const provenanceOf = (sessionId: string): Provenance => {
    let found = provenances.get(sessionId);
    if (found === undefined) {
      found = createProvenance();
      provenances.set(sessionId, found);
      if (provenances.size > MAX_PROVENANCES) provenances.delete(provenances.keys().next().value as string);
    }
    return found;
  };

  // RT-42: in read-only database mode the mirror still appends (it is a file), but nothing is posted or tainted: the notice waits.
  const deferred: Array<() => void> = [];
  let overflowSaid = false;
  const post = (work: () => void): void => {
    if (deps.canWrite()) work();
    else if (deferred.length < MAX_DEFERRED) deferred.push(work);
    else if (!overflowSaid) {
      overflowSaid = true;
      logger.warn("agent_mirror_notices_dropped", { max: MAX_DEFERRED });
    }
  };
  const flush = (): void => {
    if (deferred.length === 0 || !deps.canWrite()) return;
    overflowSaid = false;
    for (const work of deferred.splice(0)) work();
  };

  return {
    inputFor(row, resources) {
      flush();
      const sessionFile = mirrorFileOf(papHome, row);
      // The quota and the logs are keyed by the box's id: an agent's or a project's (they never share a spelling).
      const agentId = row.agentId ?? row.projectId;
      const limitBytes = (resources?.diskMb ?? DEFAULT_AGENT_RESOURCES.diskMb) * MIB;
      const provenance = provenanceOf(row.id);
      const announce = (kind: "replaced" | "quota"): void =>
        post(() => {
          if (kind === "quota") return deps.notice(row.id, QUOTA_NOTICE);
          deps.notice(row.id, REPLACED_NOTICE);
          deps.taint(row.id);
        });
      return {
        sessionFile,
        sessionsDir: "",
        sent: (text) => provenance.sent(text),
        // Its launch is failing, so there is no next start for the held-notice path to post at: the notice is shown now.
        lost: () => post(() => deps.notice(row.id, FILE_LOST_NOTICE, true)),
        unsent: (message) => {
          const text = userTextOf(message);
          return text !== null && !provenance.peek(promptHash(text));
        },
        mirrorFor(file): MirrorPort | "refused" {
          try {
            if (agentId === undefined || (sessionFile !== null && file !== sessionFile))
              throw new Error("not this file");
            const path =
              row.agentId === undefined
                ? projectMirrorPathOf(papHome, agentId, file)
                : mirrorPathOf(papHome, agentId, file);
            const port = openMirror(path, {
              clock,
              logger,
              agentId,
              parser,
              provenance,
              quota,
              limitBytes,
              announce,
              createOnly: sessionFile === null,
            });
            return {
              path: port.path,
              facts: () => port.facts(),
              onSessionAppend: (append) => {
                flush();
                return port.onSessionAppend(append);
              },
              close: () => port.close(),
            };
          } catch (error) {
            logger.warn("agent_mirror_refused", { agentId: agentId ?? null, reason: "file", err: error });
            return "refused";
          }
        },
      };
    },
    start: () => sweeper.start(),
    close() {
      sweeper.stop();
      void parser.stop();
    },
  };
}

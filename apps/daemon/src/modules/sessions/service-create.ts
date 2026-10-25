import { type Caller, PapError } from "@pap/contracts";
import { newBoxCwdOf } from "./box-cwd.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { createForks } from "./forks.ts";
import type { createAdoption } from "./service-adopt.ts";
import { filedOf } from "./service-helpers.ts";
import type { SessionsService, SessionsServiceDeps } from "./service-types.ts";
import type { createProjectLink } from "./project-link.ts";
import type { createShellPublisher } from "./shell-publisher.ts";
import { type SessionRow, type StoredPreset, storedPresetOf } from "./store.ts";
import type { LiveSession } from "./live-session.ts";
import type { createAgentSurface } from "./agent-surface.ts";
import type { createPolicyLink } from "./policy-link.ts";

/** What the making of sessions needs of `createSessionsService`: its own wiring, handed over as is. */
export interface SessionCreateContext {
  readonly deps: SessionsServiceDeps;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly agent: ReturnType<typeof createAgentSurface>;
  readonly policyLink: ReturnType<typeof createPolicyLink>;
  readonly adoption: ReturnType<typeof createAdoption>;
  readonly link: ReturnType<typeof createProjectLink>;
  readonly publisher: ReturnType<typeof createShellPublisher>;
  readonly marks: { row(id: string): { projectId: string | null } | null | undefined };
  readonly launch: (row: SessionRow, isNew: boolean) => Promise<LiveSession>;
  readonly owned: (sessionId: string, caller: Caller) => SessionRow;
  readonly presetOf: (row: SessionRow) => StoredPreset | null;
}

/** The sessions a person makes: a new one, a fork and a clone, moved out of `service.ts` as is. */
export function createSessionCreate(
  ctx: SessionCreateContext,
): Pick<SessionsService, "create" | "fork" | "clone"> {
  const { deps, live, agent, policyLink, adoption, link, publisher, marks, launch, owned, presetOf } = ctx;

  const forks = createForks({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    loadWriter: deps.loadWriter,
    ...(deps.admission ? { admit: deps.admission.fork } : {}),
    onMade: adoption.fileMade,
    // A fork or clone never starts looser than its source: mode and taint (owner Q15), and the tool preset (Task 15).
    onAdopted: (source, id) => {
      policyLink.inherit(source, id);
      deps.store.setToolPreset(id, presetOf(source));
    },
  });
  // A fork would be a second thread, or a plain session in the agent's home (M11R179). A project box's session file is the VM's:
  // the host's Pi never opens it, so the refusal comes before the writer is loaded.
  const notInVm = (row: SessionRow): SessionRow => {
    if (row.agentId !== undefined) throw new PapError("bad_request");
    if (agent.vmLayoutOf(row) !== null) throw new PapError("sandbox_unavailable");
    return row;
  };

  const filed = filedOf(link, publisher);

  return {
    async create(cwdInput, caller, preset) {
      const cwd =
        newBoxCwdOf(deps.boxes?.(), caller.userId, cwdInput, deps.isMember)?.cwd ??
        resolveSessionCwd(cwdInput, deps.worker.papHome);
      const now = deps.clock.now();
      const toolPreset = preset === undefined ? null : storedPresetOf(preset);
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd,
        ownerId: caller.userId,
        name: null,
        createdAt: now,
        updatedAt: now,
        ...(toolPreset ? { toolPreset } : {}),
      };
      await launch(row, true);
      publisher.changed(row.id);
      publisher.projectChanged(caller.userId, marks.row(row.id)?.projectId ?? null);
      return { sessionId: row.id };
    },
    fork: async ({ sessionId, entryId }, caller) => {
      const row = notInVm(owned(sessionId, caller));
      return filed(row, await forks.fork(row, entryId));
    },
    clone: async ({ sessionId }, caller) => {
      const row = notInVm(owned(sessionId, caller));
      return filed(row, await forks.clone(row, live.get(row.id)?.leafId() ?? null));
    },
  };
}

import { type Caller, PapError } from "@pap/contracts";
import type { LiveSession } from "./live-session.ts";
import type { MemoryRelease } from "./memory-trust.ts";
import { createPromptAttachments, plainPrompt } from "./prompt-attachments.ts";
import { vmTargets } from "./vm-attachments.ts";
import type { PromptInput, SessionsService, SessionsServiceDeps } from "./service-types.ts";
import type { SessionRow } from "./store.ts";

/** What a prompt needs of `createSessionsService`: its own wiring, handed over as is. */
export interface PromptFlowContext {
  readonly deps: SessionsServiceDeps;
  readonly memory: MemoryRelease;
  readonly ensureLive: (row: SessionRow) => Promise<LiveSession>;
  readonly organiser: { activity(sessionId: string): void };
  readonly publisher: { changed(sessionId: string): void };
  readonly owned: (sessionId: string, caller: Caller) => SessionRow;
}

/**
 * A prompt's path to its worker, moved out of `service.ts` as is. The order is binding: claim the attachments, bring the
 * worker up, the lane wait, the memory release (`renew`), then `stillWanted`, with no await between that read and
 * `worker.prompt()`.
 */
export function createPromptFlow(ctx: PromptFlowContext) {
  const attachments = createPromptAttachments(ctx.deps);
  return async (input: PromptInput, caller: Caller): ReturnType<SessionsService["prompt"]> => {
    const row = ctx.owned(input.sessionId, caller);
    // A token never makes an agent's trusted thread run (M11R4, W5-R64): refused first, before any lane wait (I1).
    if (caller.kind === "token" && row.agentId !== undefined) throw new PapError("forbidden");
    // Claimed for this session and owner before a worker is asked for anything; released only once Pi accepted (M8R43).
    const ids = input.attachments ?? [];
    const prepared =
      ids.length === 0
        ? plainPrompt(input.text)
        : await attachments.prepare(caller.userId, row.id, input.text, ids);
    const session = await ctx.ensureLive(row);
    const target = vmTargets.get(session);
    // R33: a VM agent cannot read host files; its attachments go into its inbox first and the prompt names the VM paths.
    const sent = target && prepared.vm ? await prepared.vm(target) : prepared;
    ctx.deps.store.touch(row.id, ctx.deps.clock.now());
    ctx.organiser.activity(row.id);
    ctx.publisher.changed(row.id);
    const waiting = ctx.deps.laneHooks?.beforePrompt(row, session, input.streamingBehavior);
    if (waiting) await waiting;
    // A release a taint could not make yet is made now (M11R143): the prompt runs on a worker that starts closed.
    const renewal = ctx.memory.renew(row, session, ctx.ensureLive);
    const worker = renewal ? await renewal : session;
    // Asked and sent in one step: nothing is awaited between the answer and the worker's request.
    if (input.stillWanted && !input.stillWanted()) return { disposition: "handled" };
    const result = await worker.prompt(sent.text, input.streamingBehavior, sent.images);
    prepared.accepted();
    return result;
  };
}

import {
  type Caller,
  type HELPER_OPS,
  TEMPLATE_AUDIT_REASON,
  type TemplatesSaveParams,
  type TemplatesSaveResult,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { AuditPort } from "../audit/index.ts";
import { requireStepUp } from "../auth/index.ts";

const WRITE_DEADLINE_MS = 30_000;

export interface TemplatesDeps {
  readonly run: (
    op: "templates.write",
    params: unknown,
    deadlineMs: number,
  ) => Promise<z.infer<(typeof HELPER_OPS)["templates.write"]["result"]>>;
  readonly writes: PiWriteQueue;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
}

/** The prompt templates of Pi's own folder (UX-1): the owner's password step-up, the shared Pi write queue, one audit row. */
export function createTemplates(deps: TemplatesDeps) {
  return {
    async save(caller: Caller, params: TemplatesSaveParams): Promise<TemplatesSaveResult> {
      requireStepUp(caller, deps.clock.now());
      const { replaced } = await deps.writes.run(() =>
        deps.run("templates.write", params, WRITE_DEADLINE_MS),
      );
      // The name only: the body and the description are the owner's prompt text and stay out of the audit.
      deps.audit.append({
        ownerId: caller.userId,
        actor: "user",
        kind: "auth",
        reason: TEMPLATE_AUDIT_REASON,
        detail: { name: params.name },
      });
      return { name: params.name, replaced };
    },
  };
}

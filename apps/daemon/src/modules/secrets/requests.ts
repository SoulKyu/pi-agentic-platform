import { type Caller, PapError, VaultName, VaultUpdateRecord, VaultValue } from "@pap/contracts";
import { randomUUID } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { cleanText, type Requests } from "../agents/index.ts";
import type { AuditPort } from "../audit/index.ts";
import { type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import { ONCE_LIMITS, type OnceStore, refHash, refOf } from "./refs.ts";
import { actorOf, type Secrets, type SecretsDeps } from "./service.ts";

/**
 * How long the agent waits: 30 minutes, less the 2 seconds the platform deadline (`PLATFORM_OPS`) would otherwise win by.
 * The op then answers `timeout` and marks the request `expired` instead of the dispatcher answering and leaving the card open.
 */
export const SECRET_WAIT_MS = 30 * 60_000 - 2_000;
const REASON_UNITS = 500;

export interface SecretRequestsDeps {
  readonly requests: Pick<Requests, "open" | "wait" | "expire" | "cancel" | "secretOf" | "closeSecret">;
  /** "Save in the vault" goes through the vault's own `set` (audit, push to the live workers); `vaultOf` is the live vault. */
  readonly secrets: Pick<Secrets, "set" | "vaultOf">;
  readonly once: Pick<OnceStore, "put" | "forSession" | "roomFor">;
  /** The 32 bytes of `ref-salt`: read when the first ref is made, never at boot. */
  readonly salt: () => Buffer;
  readonly sessions: {
    /** The worker of this session started with the sandbox on. */
    sandboxed(ownerId: string, sessionId: string): boolean;
    sendToAgent: SecretsDeps["sessions"]["sendToAgent"];
  };
  readonly probe: { ensure(): Promise<{ readonly usable: boolean }> };
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Logger;
  readonly readOnly: boolean;
}

type Mode = "once" | "vault";

/**
 * `secret.request` and the owner's answer (M11R103 to M11R105). The agent asks by NAME; the owner types the value in the
 * browser and chooses "use once" (the value waits in memory and in the asking worker for its next command that names
 * `$NAME`) or "save in the vault". The agent gets a ref, never the value: no result, row, audit line, log line or Inbox
 * item holds it.
 */
export function createSecretRequests(deps: SecretRequestsDeps) {
  const { requests, logger } = deps;
  /** How each answered request was answered, until its op reads it: bounded by the open requests (3 per agent). */
  const modes = new Map<string, Mode>();

  const writable = (caller: Caller): void => {
    // Fail closed: only a browser session answers (a token never does, owner m15).
    if (caller.kind !== "session") throw new PapError("forbidden");
    if (deps.readOnly) throw new PapError("read_only");
  };

  /** The class name of a failure, never its message (a message could hold a value). */
  const errorClassOf = (error: unknown): string =>
    error instanceof Error ? error.constructor.name.slice(0, 64) : "non_error";

  /** One audit row; false, with the failure logged by its class, when it could not be written. */
  function audited(caller: Caller, reason: string, detail: Record<string, string>): boolean {
    try {
      deps.audit.append({ ownerId: caller.userId, ...actorOf(caller), kind: "policy", reason, detail });
      return true;
    } catch (error) {
      logger.warn("secret_audit_failed", { errorClass: errorClassOf(error) });
      return false;
    }
  }

  const op: PlatformHandler<"secret.request"> = async (args, ctx) => {
    if (ctx.agentId === null) throw new PlatformRefusal("not_found");
    if (ctx.signal.aborted) throw new PlatformRefusal("cancelled");
    // First of all (RT-17): a value for a shell that is not sandboxed would never be used, and a vault value never reaches one.
    if (!deps.sessions.sandboxed(ctx.ownerId, ctx.sessionId))
      throw new PlatformRefusal("sandbox_unavailable");
    if (!(await deps.probe.ensure()).usable) throw new PlatformRefusal("sandbox_unavailable");
    if (ctx.signal.aborted) throw new PlatformRefusal("cancelled");
    const id = requests.open({
      kind: "secret",
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      title: args.name,
      detail: cleanText(args.reason, REASON_UNITS),
      expiresAt: deps.clock.now() + SECRET_WAIT_MS,
    });
    const timer = deps.clock.setTimeout(
      () => void guardTimer(logger, "secret_request_expiry", () => void requests.expire(id), deps.clock),
      SECRET_WAIT_MS,
    );
    const stop = () => void requests.cancel(id);
    ctx.signal.addEventListener("abort", stop, { once: true });
    try {
      if (ctx.signal.aborted) stop();
      const end = await requests.wait(id);
      const mode = modes.get(id);
      if (end === "answered" && mode !== undefined)
        return { ref: refOf(deps.salt(), id), name: args.name, mode };
      if (end === "declined") throw new PlatformRefusal("refused");
      if (end === "expired") throw new PlatformRefusal("timeout");
      if (end === "cancelled") throw new PlatformRefusal("cancelled");
      throw new PlatformRefusal("internal");
    } finally {
      deps.clock.clearTimeout(timer);
      ctx.signal.removeEventListener("abort", stop);
      modes.delete(id);
    }
  };

  return {
    op,

    /**
     * `secrets.answerRequest`. Everything that can refuse comes before anything is kept: a name or value the vault refuses is
     * `bad_request` and a fourth waiting one-use value is `limit_reached`, with the request still open. Then the answer is
     * audited, the value is kept (the vault, or memory and the asking worker), and the request closes with the ref's hash.
     */
    answer(caller: Caller, input: { requestId: string; value: string; mode: Mode }): void {
      writable(caller);
      const row = requests.secretOf(caller.userId, input.requestId);
      if (!row) throw new PapError("not_found");
      if (!VaultName.safeParse(row.name).success || !VaultValue.safeParse(input.value).success)
        throw new PapError("bad_request");
      const ref = refOf(deps.salt(), row.id);
      // A fourth waiting value is refused before anything is audited or kept.
      if (input.mode === "once" && !deps.once.roomFor(row.agentId)) throw new PapError("limit_reached");
      // The audit row comes right before the value is kept: an answer that cannot be traced is refused, and nothing is kept.
      const trace = (): void => {
        const detail = { agentId: row.agentId, requestId: row.id, name: row.name, mode: input.mode };
        if (!audited(caller, "secret answer", detail)) throw new PapError("internal");
      };
      // The answer row is already written: a keep that then fails says so in a second row, with the code only.
      const failedWith = (error: unknown): never => {
        const code = error instanceof PapError ? error.code : "internal";
        audited(caller, "secret answer failed", { agentId: row.agentId, requestId: row.id, code });
        throw error;
      };
      if (input.mode === "vault") {
        trace();
        try {
          deps.secrets.set(caller, { agentId: row.agentId, name: row.name, value: input.value });
        } catch (error) {
          failedWith(error);
        }
      } else {
        // Built (and parsed) before anything is kept, so a record that does not parse leaves nothing held. The worker gets
        // the session's full list, this value included (W5-R37).
        const id = randomUUID();
        const entry = {
          id,
          name: row.name,
          value: input.value,
          expiresAt: deps.clock.now() + ONCE_LIMITS.ttlMs,
        };
        const parsed = VaultUpdateRecord.safeParse({
          type: "vault_update",
          vault: deps.secrets.vaultOf(caller.userId, row.agentId),
          once: [...deps.once.forSession(row.sessionId), entry].slice(-3),
        });
        if (!parsed.success) {
          // The cause is pap's own vault data (the name and value were checked above): not the owner's mistake.
          logger.warn("secret_once_record_invalid");
          throw new PapError("internal");
        }
        trace();
        const kept = deps.once.put(ref, {
          id,
          agentId: row.agentId,
          sessionId: row.sessionId,
          name: row.name,
          value: input.value,
        });
        if (kept === "limit_reached") failedWith(new PapError("limit_reached"));
        const record = VaultUpdateRecord.parse({ ...parsed.data, once: deps.once.forSession(row.sessionId) });
        try {
          deps.sessions.sendToAgent(caller.userId, row.agentId, record, row.sessionId);
        } catch (error) {
          // The value waits in memory: the worker gets it with its next start (`init.once`).
          logger.warn("secret_once_not_sent", { errorClass: errorClassOf(error) });
        }
      }
      modes.set(row.id, input.mode);
      if (!requests.closeSecret(row.id, "answered", refHash(ref))) {
        modes.delete(row.id);
        logger.warn("secret_request_close_lost");
      }
    },

    /** `secrets.declineRequest`: the agent is refused; nothing is kept. */
    decline(caller: Caller, input: { requestId: string }): void {
      writable(caller);
      const row = requests.secretOf(caller.userId, input.requestId);
      if (!row) throw new PapError("not_found");
      audited(caller, "secret decline", { agentId: row.agentId, requestId: row.id, name: row.name });
      requests.closeSecret(row.id, "declined", null);
    },
  };
}
export type SecretRequests = ReturnType<typeof createSecretRequests>;

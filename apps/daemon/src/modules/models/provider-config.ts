import {
  type Caller,
  type ConfigSaveResult,
  type HELPER_OPS,
  PapError,
  type PROVIDER_AUDIT_REASONS,
  type ProviderGetResult,
  type ProviderRemoveParams,
  type ProviderSaveParams,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { requireStepUp } from "../auth/index.ts";

/** Reading is quick; a write waits for Pi's settings lock (the same figures as the service's). */
const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 30_000;
/** Longest text of a provider id in an audit line, after escaping. */
const AUDIT_ID_MAX = 64;

type OpName = "models.provider.get" | "models.provider.save" | "models.provider.remove" | "auth.logout";
/** The service's `run`: the result is parsed with the op's contract schema before it comes back. */
export type Run = <N extends OpName>(
  op: N,
  params: unknown,
  deadlineMs: number,
  cwd: undefined,
  onEvent?: (event: unknown) => void,
) => Promise<ReturnType<(typeof HELPER_OPS)[N]["result"]["parse"]>>;

type AuditReason = (typeof PROVIDER_AUDIT_REASONS)[number];

/**
 * A provider id for an audit line. `get` and `remove` take any id the file holds, so it is untrusted text: every
 * character outside printable ASCII (and the backslash) is written as a `\uXXXX` escape, and the line is clipped.
 */
export function auditId(id: string): string {
  let out = "";
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    const piece =
      code >= 0x20 && code <= 0x7e && char !== "\\"
        ? char
        : code <= 0xffff
          ? `\\u${hex.padStart(4, "0")}`
          : `\\u{${hex}}`;
    if (out.length + piece.length > AUDIT_ID_MAX) return `${out}...`;
    out += piece;
  }
  return out;
}

/**
 * The provider form's three methods (MPR8, MPR12, MPR14). Save and remove take the password step-up first, run in the
 * daemon's one Pi write queue (with `models.config.save`, MC28/29) and always clear the `models.available` cache. The
 * `baseRevision` is the one the form READ with `get` (MP-RT-03): the daemon never fetches one for it. Audit lines name
 * the provider and nothing else; a key is never in these params (it goes through `models.setApiKey`).
 */
export function createProviderConfig(deps: {
  readonly run: Run;
  readonly serialised: <T>(task: () => Promise<T>) => Promise<T>;
  readonly revisionKey: string;
  readonly clock: Clock;
  readonly audit: (caller: Caller, reason: AuditReason, detail: Record<string, string>) => void;
  readonly invalidate: () => void;
  readonly logSaveEvent: (event: unknown) => void;
}) {
  const { run, serialised, revisionKey, clock } = deps;
  /** The write goes through the queue, whatever its outcome: a failed write may still have changed the file. */
  const cleared = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await serialised(task);
    } finally {
      deps.invalidate();
    }
  };
  return {
    /** No id: only the file's revision comes back, for a form that creates. No step-up, no audit. */
    async get(_caller: Caller, params: { id?: string }): Promise<ProviderGetResult> {
      const id = params.id === undefined ? {} : { id: params.id };
      return run("models.provider.get", { ...id, revisionKey }, READ_DEADLINE_MS, undefined);
    },
    async save(caller: Caller, params: ProviderSaveParams): Promise<ConfigSaveResult> {
      requireStepUp(caller, clock.now());
      const result = await cleared(() =>
        run(
          "models.provider.save",
          { ...params, revisionKey },
          WRITE_DEADLINE_MS,
          undefined,
          deps.logSaveEvent,
        ),
      );
      if ("revision" in result) deps.audit(caller, "provider_saved", { provider: params.id });
      return result;
    },
    /**
     * The entry only; the stored key goes too when the owner ticked it, in the same queue slot so no other write comes
     * between. A key that could not be removed after the entry went is an error, and the removal is audited first.
     */
    async remove(caller: Caller, params: ProviderRemoveParams): Promise<ConfigSaveResult> {
      requireStepUp(caller, clock.now());
      const provider = auditId(params.id);
      return cleared(async () => {
        const result = await run(
          "models.provider.remove",
          { ...params, revisionKey },
          WRITE_DEADLINE_MS,
          undefined,
          deps.logSaveEvent,
        );
        if (!("revision" in result)) return result;
        deps.audit(caller, "provider_removed", { provider });
        if (params.alsoRemoveKey) {
          try {
            await run("auth.logout", { provider: params.id }, WRITE_DEADLINE_MS, undefined);
            deps.audit(caller, "provider_signed_out", { provider });
          } catch (error) {
            // Neither Pi nor auth.json knows the id: there was no key to remove, and the removal stands.
            if (!(error instanceof PapError && error.code === "not_found")) throw error;
          }
        }
        return result;
      });
    },
  };
}

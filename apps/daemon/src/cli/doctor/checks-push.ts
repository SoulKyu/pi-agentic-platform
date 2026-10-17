import { lstatSync } from "node:fs";
import { join } from "node:path";
import { listenFacts, type ListenFacts } from "./listen-facts.ts";
import type { Check, CheckResult, CheckStatus } from "./types.ts";

export type ReadinessStatus =
  "ready" | "localhost_only" | "insecure_http" | "origin_mismatch" | "keys_unreadable";

/** M12's pure `pushReadiness(facts)` (kernel/push-readiness.ts) has this shape; the registry injects it at the rebase. */
export type Readiness = (facts: ListenFacts) => { status: ReadinessStatus; hint?: string };

/** What the key-file check reads. Tests replace it; nothing here writes or follows a link. */
export interface PushProbes {
  /** The user pap runs as. */
  readonly uid: number;
  /** `lstat`: null when the path does not exist, a throw for any other error. */
  readonly lstat: (path: string) => { mode: number; uid: number; kind: "file" | "dir" | "other" } | null;
}

export function defaultPushProbes(): PushProbes {
  return {
    uid: process.getuid?.() ?? -1,
    lstat(path) {
      try {
        const s = lstatSync(path);
        return { mode: s.mode, uid: s.uid, kind: s.isFile() ? "file" : s.isDirectory() ? "dir" : "other" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

const RANK: Record<CheckStatus, number> = { ok: 0, skip: 0, info: 1, warn: 2, fail: 3 };

/** M12's order: the ngrok origin (decision 75), Tailscale serve, a reverse proxy, then a certificate of pap's own. */
const HTTPS_DOC = "docs/agents/notifications.md#https";
const HTTPS_ROUTES = `${HTTPS_DOC}. Routes, in order: an ngrok origin, \`tailscale serve\`, a reverse proxy with PAP_PUBLIC_ORIGIN set to its address, then --tls-cert and --tls-key`;

const withHint = (fix: string, hint: string | undefined): string =>
  hint === undefined ? fix : `${hint} (${fix})`;

/** The routes appear once: M12's hint already lists them, so with a hint only the anchor is added; without one, the full text. */
const httpsFix = (hint: string | undefined): string =>
  hint === undefined ? HTTPS_ROUTES : `${hint} See ${HTTPS_DOC}`;

/** The `push` line points at the `https` line's text instead of repeating the routes; a hint about the origin itself stays. */
const pushHttpsFix = (status: ReadinessStatus, hint: string | undefined): string =>
  status === "origin_mismatch" && hint !== undefined ? `${hint} See ${HTTPS_DOC}` : HTTPS_DOC;

/** The unit exists but pap cannot parse its ExecStart (a hand-written unit): it must not be read as "listens on localhost". */
const unreadableDetail = (unit: string): string => `cannot read the listen flags of ${unit}`;
const UNREADABLE_FIX = `check --host, --tls-cert and --insecure-http of the unit by hand; ${HTTPS_DOC}`;

/** One table for both checks (cross-plan agreement 3). `keys_unreadable` is a key problem, not an HTTPS one. */
const HTTPS_STATUS: Record<ReadinessStatus, CheckStatus> = {
  ready: "ok",
  localhost_only: "info",
  insecure_http: "warn",
  origin_mismatch: "warn",
  keys_unreadable: "ok",
};
const PUSH_STATUS: Record<ReadinessStatus, CheckStatus> = { ...HTTPS_STATUS, keys_unreadable: "warn" };

export function makeHttpsCheck(readiness: Readiness): Check {
  return {
    id: "https",
    title: "HTTPS for push and the installable app",
    async run(ctx) {
      if (ctx.unitUnreadable === true)
        return { status: "info", detail: unreadableDetail(ctx.unitName), fix: UNREADABLE_FIX };
      const facts = listenFacts(ctx.unit, ctx.env);
      const answer = readiness(facts);
      const status = HTTPS_STATUS[answer.status];
      if (status === "ok") return { status, detail: `${facts.publicOrigin} is reached over a secure origin` };
      const detail =
        answer.status === "localhost_only"
          ? "http://localhost works on this machine only: push notifications and the installable app need HTTPS"
          : answer.status === "insecure_http"
            ? `${facts.publicOrigin} is plain HTTP: push notifications and the installable app need HTTPS`
            : `${facts.publicOrigin} does not match how pap is reached (${answer.status})`;
      return { status, detail, fix: httpsFix(answer.hint) };
    },
  };
}

const KEY_FIX = (file: string, dir: string): string =>
  `chmod 600 ${file} && chmod 700 ${dir}, or delete the file to start over (each device re-enables)`;

/** M12's predicate (cross-plan agreement 3): a regular file 0600 in a folder 0700, both owned by pap's user. */
function keyFileState(probes: PushProbes, file: string, dir: string): "absent" | "fine" | string {
  try {
    const found = probes.lstat(file);
    if (found === null) return "absent";
    if (found.kind !== "file" || (found.mode & 0o777) !== 0o600 || found.uid !== probes.uid)
      return "the key file is not a regular file of mode 0600 owned by this user";
    const parent = probes.lstat(dir);
    if (
      parent === null ||
      parent.kind !== "dir" ||
      (parent.mode & 0o777) !== 0o700 ||
      parent.uid !== probes.uid
    )
      return "the key folder is not a folder of mode 0700 owned by this user";
    return "fine";
  } catch {
    return "the key file cannot be inspected";
  }
}

export function makePushCheck(readiness: Readiness, probes: PushProbes = defaultPushProbes()): Check {
  return {
    id: "push",
    title: "Push notifications",
    async run(ctx) {
      const answer = ctx.unitUnreadable === true ? null : readiness(listenFacts(ctx.unit, ctx.env));
      const dir = join(ctx.home, "secrets", "push");
      const file = join(dir, "vapid.json");
      const state = keyFileState(probes, file, dir);
      const problem = state === "absent" || state === "fine" ? null : state;
      const parts: Array<{ status: CheckStatus; detail: string; fix?: string }> = [];
      if (answer === null)
        parts.push({ status: "info", detail: unreadableDetail(ctx.unitName), fix: UNREADABLE_FIX });
      else {
        const fromReadiness = PUSH_STATUS[answer.status];
        if (answer.status === "localhost_only")
          parts.push({
            status: fromReadiness,
            detail: "http://localhost works on this machine only: push needs HTTPS",
            fix: pushHttpsFix(answer.status, answer.hint),
          });
        else if (fromReadiness !== "ok" && answer.status !== "keys_unreadable")
          parts.push({
            status: fromReadiness,
            detail: `push is off (${answer.status})`,
            fix: pushHttpsFix(answer.status, answer.hint),
          });
      }
      if (problem !== null || answer?.status === "keys_unreadable")
        parts.push({
          status: "warn",
          detail: `push is off (keys_unreadable): ${problem ?? "the daemon cannot read its push keys"}`,
          fix: withHint(KEY_FIX(file, dir), answer?.hint),
        });
      if (parts.length === 0)
        return {
          status: "ok",
          detail:
            state === "absent"
              ? "push is ready; the key is created at the first start"
              : "push is ready and its key file is private to this user",
        };
      const worst = parts.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
      const fixes = parts.flatMap((p) => (p.fix === undefined ? [] : [p.fix]));
      return {
        status: worst.status,
        detail: parts.map((p) => p.detail).join("; "),
        ...(fixes.length > 0 ? { fix: fixes.join(" | ") } : {}),
      } satisfies CheckResult;
    },
  };
}

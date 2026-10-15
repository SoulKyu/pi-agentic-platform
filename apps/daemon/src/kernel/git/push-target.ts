import { parseRemote, type RemoteRef } from "../forge/remote.ts";

export type PushTarget =
  | { readonly ok: true; readonly target: RemoteRef }
  | { readonly ok: false; readonly reason: "no_remote" | "unsupported_remote" | "repo_config" };

/**
 * Where a push would really go (M9-RT-02). `originUrls`: every `remote.origin.url` value as configured; `pushUrls`: every
 * line of `remote get-url --push --all origin` (after `pushurl`, `insteadOf` and `pushInsteadOf`). Exactly one of each,
 * and the push URL names the same host and repository as the origin URL (a same-repository ssh `pushurl` beside an
 * https `url` is fine); else `repo_config`. `allowFile` is the test protocol seam only: a local path or `file:` URL (beside a local or a forge origin) is
 * answered as `{ host: "local", path: <its last segment> }`.
 */
export function pushTarget(input: {
  readonly originUrls: readonly string[];
  readonly pushUrls: readonly string[];
  readonly allowFile: boolean;
}): PushTarget {
  if (input.originUrls.length === 0 || input.pushUrls.length === 0) return { ok: false, reason: "no_remote" };
  if (input.originUrls.length !== 1 || input.pushUrls.length !== 1)
    return { ok: false, reason: "repo_config" };
  const [origin, push] = [input.originUrls[0] as string, input.pushUrls[0] as string];
  const local = (url: string): boolean => url.startsWith("file://") || url.startsWith("/");
  if (input.allowFile && local(push)) {
    // The owner's global `insteadOf` may have carried a forge identity to a local bare repository (Task 14's tests).
    if (!local(origin) && parseRemote(origin) === null) return { ok: false, reason: "repo_config" };
    const last = push.replace(/\/+$/, "").split("/").at(-1) ?? "";
    return { ok: true, target: { host: "local", path: last } };
  }
  const identity = parseRemote(origin);
  const target = parseRemote(push);
  if (identity === null || target === null) return { ok: false, reason: "unsupported_remote" };
  if (target.host !== identity.host || target.path !== identity.path)
    return { ok: false, reason: "repo_config" };
  return { ok: true, target };
}

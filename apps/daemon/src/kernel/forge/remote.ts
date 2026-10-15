import type { ForgeKind } from "@pap/contracts";

export interface RemoteRef {
  readonly host: string;
  /** `owner/repo`, or `group/subgroup/project`: 2 to 8 segments. */
  readonly path: string;
}
export interface IssueRef extends RemoteRef {
  readonly number: number;
  readonly kind: ForgeKind;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const cleanSegments = (segments: readonly string[]): boolean =>
  segments.length >= 2 &&
  segments.length <= 8 &&
  segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");

/** The host and repository path of a remote URL; credentials and ports dropped; null for any other transport. */
export function parseRemote(url: string): RemoteRef | null {
  if (
    url.length > 2048 ||
    /[^\x21-\x7e]/.test(url) ||
    /[\\?#%]/.test(url) ||
    url.split("@").length > 2 ||
    /\/\.\.?(?:\/|$)/.test(url)
  )
    return null;
  let host: string;
  let path: string;
  const scp = /^(?:[A-Za-z0-9._-]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
  if (/^(?:https|ssh|git\+ssh):\/\//.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    try {
      path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else if (scp) {
    host = (scp[1] as string).toLowerCase();
    path = scp[2] as string;
  } else return null;
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  const segments = path.split("/");
  if (!HOST.test(host) || !cleanSegments(segments)) return null;
  return { host, path: segments.join("/") };
}

/** Public forges pap knows by name: their kind wins over a repository's own `forge:` line (M9-RT-04). */
const KNOWN: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "gitea",
  "gitea.com": "gitea",
};
export const forgeOf = (host: string, override: ForgeKind | undefined): ForgeKind | null =>
  Object.hasOwn(KNOWN, host) ? (KNOWN[host] as ForgeKind) : (override ?? null);

/** `https://<host>/<repo>/issues/<n>` (GitHub, Gitea) or `https://<host>/<group…>/<project>/-/issues/<n>` (GitLab). */
export function parseIssueUrl(text: string, override?: ForgeKind): IssueRef | null {
  const input = text.trim();
  if (input.length > 2048 || !input.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1);
  const last = parts.at(-1) ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(last) || parts.at(-2) !== "issues") return null;
  const gitlabForm = parts.at(-3) === "-";
  const repo = gitlabForm ? parts.slice(0, -3) : parts.slice(0, -2);
  if (!cleanSegments(repo)) return null;
  const kind = forgeOf(host, override) ?? (gitlabForm ? "gitlab" : null);
  if (kind === null || (kind === "gitlab") !== gitlabForm) return null;
  return { host, path: repo.join("/"), number: Number(last), kind };
}

/**
 * A forge call goes only where the owner meant it (M9-RT-04): to any repository on github.com, or to the project's own forge host (its `remote.origin.url`, the configured spelling). Anything else,
 * a pasted link to another host included, is refused before a CLI starts.
 */
export function issueAllowed(
  issue: IssueRef,
  project: { readonly remote: RemoteRef | null; readonly forge: ForgeKind | null },
): boolean {
  if (issue.host === "github.com") return issue.kind === "github";
  return project.remote !== null && project.remote.host === issue.host && project.forge === issue.kind;
}

/** The canonical issue URL rebuilt from its parsed parts (M9-RT-15): no query, no fragment, no other spelling. */
export const issueUrl = (issue: IssueRef): string =>
  `https://${issue.host}/${issue.path}/${issue.kind === "gitlab" ? "-/" : ""}issues/${issue.number}`;

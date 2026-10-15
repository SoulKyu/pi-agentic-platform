import type { ForgeKind } from "@pap/contracts";

/**
 * The web's copy of the daemon's `parseIssueUrl` (`kernel/forge/remote.ts`): the same rule, so the Fetch button shows
 * for exactly the links the daemon takes. It decides nothing: the daemon still judges the host (`unsupported_url`).
 */
export interface IssueRef {
  readonly host: string;
  readonly path: string;
  readonly number: number;
  readonly kind: ForgeKind;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const KNOWN: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "gitea",
  "gitea.com": "gitea",
};
const cleanSegments = (segments: readonly string[]): boolean =>
  segments.length >= 2 &&
  segments.length <= 8 &&
  segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");

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
  const kind = (Object.hasOwn(KNOWN, host) ? KNOWN[host] : override) ?? (gitlabForm ? "gitlab" : null);
  if (kind === null || (kind === "gitlab") !== gitlabForm) return null;
  return { host, path: repo.join("/"), number: Number(last), kind };
}

/** The canonical URL the daemon answers an issue with: no query, no fragment, no other spelling. */
export const issueUrl = (issue: IssueRef): string =>
  `https://${issue.host}/${issue.path}/${issue.kind === "gitlab" ? "-/" : ""}issues/${issue.number}`;

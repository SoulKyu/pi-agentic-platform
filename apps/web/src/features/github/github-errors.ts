import { GITHUB_WEB_ORIGIN } from "@pap/contracts";
import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { boxFailure } from "../boxes/box-errors.ts";

/**
 * A failed GitHub action in the three parts (DESIGN.md §11). `repository` words a `not_found` as the repository, not
 * the project; every other code keeps the box words (`box_stopped`, `capacity`...) or the house text (`github_unavailable`,
 * `network`, `timeout`).
 */
export function githubFailure(failure: unknown, repository = false): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  if (code === "not_found" && repository) return "github.error.not_found";
  if (code === "conflict") return "github.error.conflict";
  if (code === "github_unavailable") return errorKey(code);
  return boxFailure(failure);
}

const originOf = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** A URL for an `href` to GitHub: only an address on GitHub's web origin, else null (no link). */
export function githubUrl(url: string): string | null {
  return originOf(url)?.origin === GITHUB_WEB_ORIGIN ? url : null;
}

/** Where `github.startCreate` may send the tab: the daemon's own page, on the origin the app is served from. */
export function createPageUrl(url: string): string | null {
  const parsed = originOf(url);
  return parsed?.origin === window.location.origin && parsed.pathname === "/github/app/new" ? url : null;
}

/** The refusal of a URL that is not where it should be: the house "GitHub is not set up" words. */
export const urlRefused = (): never => {
  throw new RpcError("github_unavailable");
};

export type FakeGithubPermission = "push" | "pull";

export interface FakeGithubAccess {
  /**
   * Makes `fullName` visible to the listed user tokens only (GitHub answers 404 to anyone else), each with its permission.
   * A repository never restricted is visible to every token with push, as before.
   */
  restrict(fullName: string, grants: Record<string, FakeGithubPermission>): void;
  /** The `permissions` GitHub answers `token` for `fullName`, or null for a 404. */
  permissionsFor(fullName: string, token: string | null): { push: boolean; pull: boolean } | null;
}

export function createFakeAccess(): FakeGithubAccess {
  const restricted = new Map<string, Record<string, FakeGithubPermission>>();
  return {
    restrict: (fullName, grants) => void restricted.set(fullName, grants),
    permissionsFor(fullName, token) {
      // An installation token (the App's own reach) sees what the installation holds, whoever the users are.
      if (token?.startsWith("ghs_")) return { push: true, pull: true };
      const grants = restricted.get(fullName);
      if (!grants) return { push: true, pull: true };
      const granted = token === null ? undefined : grants[token];
      return granted === undefined ? null : { push: granted === "push", pull: true };
    },
  };
}

/** The bearer token of a request, or null. */
export const bearerOf = (authorization: string | undefined): string | null =>
  /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? null;

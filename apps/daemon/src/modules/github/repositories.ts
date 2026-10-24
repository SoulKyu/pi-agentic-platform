import { GITHUB_LIMITS, PapError, RepoFullName } from "@pap/contracts";
import { z } from "zod";
import type { GithubCore } from "./index.ts";

const MAX_INSTALLATIONS = 20;
const Installations = z.object({ installations: z.array(z.object({ id: z.number().int().positive() })) });
const Repositories = z.object({
  repositories: z.array(
    z.object({
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string().min(1).max(256),
    }),
  ),
});

export interface PickableRepository {
  readonly fullName: RepoFullName;
  readonly private: boolean;
  readonly defaultBranch: string;
}

/** Every repository of every installation the owner can reach (organisations included), filtered by `query`, at most 100. */
export async function listRepositories(
  core: GithubCore,
  ownerId: string,
  query: string | undefined,
): Promise<PickableRepository[]> {
  const auth = { kind: "bearer", value: await core.userTokens.get(ownerId) } as const;
  const wanted = query?.trim().toLowerCase() ?? "";
  const found: PickableRepository[] = [];
  const installations = await core.client.json(Installations, {
    path: "/user/installations?per_page=100",
    auth,
  });
  for (const installation of installations.installations.slice(0, MAX_INSTALLATIONS)) {
    const page = await core.client.json(Repositories, {
      path: `/user/installations/${installation.id}/repositories?per_page=100`,
      auth,
    });
    for (const repo of page.repositories) {
      const name = RepoFullName.safeParse(repo.full_name);
      if (!name.success || !name.data.toLowerCase().includes(wanted)) continue;
      if (found.some((one) => one.fullName === name.data)) continue;
      found.push({ fullName: name.data, private: repo.private, defaultBranch: repo.default_branch });
      if (found.length >= GITHUB_LIMITS.repositories) return found;
    }
  }
  return found;
}

/** A fork lands in the owner's account: the owner must have installed the App somewhere (`not_found` names that step). */
export async function requireInstallation(core: GithubCore, ownerId: string): Promise<void> {
  const auth = { kind: "bearer", value: await core.userTokens.get(ownerId) } as const;
  const installations = await core.client.json(Installations, {
    path: "/user/installations?per_page=1",
    auth,
  });
  if (installations.installations.length === 0) throw new PapError("not_found");
}

/** `installationFor` as a project call reads it: the App not reaching the repository is `not_found`, the rest `github_unavailable`. */
export async function appReaches(core: GithubCore, repository: RepoFullName): Promise<void> {
  try {
    await core.tokens.installationFor(repository);
  } catch (error) {
    if (error instanceof PapError && ["not_found", "capacity", "github_unavailable"].includes(error.code))
      throw error;
    throw new PapError("github_unavailable");
  }
}

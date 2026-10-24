import type { IncomingMessage } from "node:http";
import type { FakeGithubResponse, FakeGithubState } from "./fake-github.ts";
import type { Json } from "./fake-github-util.ts";

type Handler = (p: Record<string, string>, body: Json, request: IncomingMessage) => FakeGithubResponse;

const bearerOf = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
};
const message = (status: number, text: string): FakeGithubResponse => ({ status, body: { message: text } });

/**
 * The installation-token routes: opening a pull request (a token that reaches the repository with `pull_requests: write`,
 * else 403; the same head and base twice is 422, as GitHub answers) and revoking the calling token (`revoked`).
 */
export function apiRoutes(
  state: Pick<FakeGithubState, "minted" | "repos" | "revoked">,
  origin: () => string,
  next: () => number,
): Array<[string, Handler]> {
  const opened = new Set<string>();
  return [
    [
      "POST /repos/:o/:r/pulls",
      (p, body, request) => {
        const full = `${p.o}/${p.r}`;
        if (!state.repos.has(full)) return message(404, "Not Found");
        const token = bearerOf(request);
        const grant = state.minted.find(
          (entry) => entry.token === token && !state.revoked.includes(entry.token),
        );
        const writes = (grant?.permissions as Record<string, string> | undefined)?.pull_requests === "write";
        if (!grant || !writes || !grant.repositories.includes(full))
          return message(403, "Resource not accessible");
        const key = `${full}:${String(body.head)}:${String(body.base)}`;
        if (opened.has(key)) return message(422, "A pull request already exists for secret-branch");
        opened.add(key);
        const number = next();
        return {
          status: 201,
          body: {
            number,
            html_url: `${origin()}/${full}/pull/${number}`,
            title: body.title,
            head: body.head,
            base: body.base,
          },
        };
      },
    ],
    [
      "DELETE /installation/token",
      (_p, _body, request) => {
        const token = bearerOf(request);
        if (token === null || !state.minted.some((entry) => entry.token === token))
          return message(401, "Bad credentials");
        state.revoked.push(token);
        return { status: 204 };
      },
    ],
  ];
}

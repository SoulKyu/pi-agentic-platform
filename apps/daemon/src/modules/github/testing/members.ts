import type { UserTokens } from "../index.ts";
import type { FakeGithub } from "../../../kernel/testing/fake-github.ts";

/** Connects `userId` to the fake GitHub with a fresh user token pair; returns the access token the fake now expects. */
export async function connectUser(
  fake: FakeGithub,
  userTokens: UserTokens,
  userId: string,
  code: string,
): Promise<string> {
  const response = await fetch(`${fake.origin}/login/oauth/access_token`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  userTokens.store(userId, (await response.json()) as Parameters<UserTokens["store"]>[1]);
  return fake.state.userTokens.access;
}

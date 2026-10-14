/**
 * The one credential vocabulary of the helper (MC32, MC40): the models.json masker and the MCP masker both ask it.
 * A name is a credential name when its letters (lowercased, everything else dropped) contain one of these words, so
 * `openaiApiKey`, `X-Key`, `ANTHROPIC_KEY` and `client_secret` all are. Over-masking is accepted.
 */
export const CREDENTIAL_WORDS: readonly string[] = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "auth",
  "bearer",
  "credential",
  "cookie",
  "pwd",
  "passphrase",
  "session",
  "signature",
];

export const credentialName = (name: string): boolean => {
  const letters = name.toLowerCase().replace(/[^a-z]/g, "");
  return CREDENTIAL_WORDS.some((word) => letters.includes(word));
};

/** The first credential word in a free text (a comment), found as it is written. */
export const COMMENT_WORD = new RegExp(`(?:${CREDENTIAL_WORDS.join("|")})`, "i");

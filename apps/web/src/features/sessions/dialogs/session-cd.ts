// `cd <folder> && `: the folder bare (no shell character), in single quotes, or in double quotes without an expansion.
// Anything the shell would expand never matches, so what is compared with the session folder is exactly what `cd` gets.
const SESSION_CD = /^cd[ \t]+(?:'([^'\n]*)'|"([^"\n$`\\!]*)"|([A-Za-z0-9_./@%+=:,-]+))[ \t]+&&[ \t]+(?=\S)/;
const COMMAND_LABEL = "bash: ";

const withoutTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Display only (decision 117, A3): the body of a bash card without a leading `cd <session folder> && `, or null when it
 * has none. Only that exact folder counts (one trailing slash allowed); any other `cd` stays visible. The policy, the
 * answer and the audit always use the full command.
 */
export function withoutSessionCd(body: string, cwd: string | undefined): string | null {
  if (cwd === undefined || !cwd.startsWith("/") || !body.startsWith(COMMAND_LABEL)) return null;
  const command = body.slice(COMMAND_LABEL.length);
  const found = SESSION_CD.exec(command);
  if (found === null) return null;
  const folder = found[1] ?? found[2] ?? found[3] ?? "";
  return withoutTrailingSlash(folder) === withoutTrailingSlash(cwd)
    ? `${COMMAND_LABEL}${command.slice(found[0].length)}`
    : null;
}

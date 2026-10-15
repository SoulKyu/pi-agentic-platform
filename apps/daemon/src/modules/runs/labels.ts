// No quote, backslash, brace, comma, space or newline: a value never needs escaping and never breaks a line.
const LABEL_VALUE = /^[A-Za-z0-9._:/@+-]{1,64}$/;

// A path-shaped id (`/home/me/m.gguf`, `~/m`, `./m`, `a/../b`) is a path, never a label (M10R97), though `/` is allowed
// inside a plain id such as `accounts/fireworks/models/x`.
const PATH_SHAPED = /^[/~.]|\.\./;

/**
 * A provider or model id as a label value or a `runs.jsonl` field (RT-23): kept only when it is plain and holds none of
 * the secret formats M5 scrubs (`scrubKnownSecrets`, injected); anything else is `other`. Session ids, paths, names and
 * text are never labels.
 */
export function labelValue(
  raw: string | null | undefined,
  scrub: (text: string) => { count: number },
): string {
  if (raw === null || raw === undefined || raw === "") return "none";
  if (!LABEL_VALUE.test(raw) || PATH_SHAPED.test(raw) || scrub(raw).count > 0) return "other";
  return raw;
}

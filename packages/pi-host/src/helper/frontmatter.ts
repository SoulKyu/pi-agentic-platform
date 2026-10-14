/** Sets (`on`) or removes one `key: true` line of a Markdown file's leading YAML frontmatter, every other byte kept. */
export function setFrontmatterFlag(text: string, key: string, on: boolean): string | null {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  const head = /^---(\r?\n)/.exec(body);
  if (head === null) return null;
  const eol = head[1] as string;
  const close = body.indexOf(`${eol}---`, head[0].length - eol.length);
  if (close === -1) return null;
  const inner = body.slice(head[0].length, close);
  const lines = inner === "" ? [] : inner.split(eol);
  const named = (line: string): boolean => line.startsWith(`${key}:`) || line.startsWith(`${key} :`);
  // A value continued on indented lines would be cut in half: refuse instead of guessing (M7R111).
  if (lines.some((line, at) => named(line) && /^[ \t]/.test(lines[at + 1] ?? ""))) return null;
  const kept = lines.filter((line) => !named(line));
  if (on) kept.push(`${key}: true`);
  return `${bom}---${eol}${kept.join(eol)}${body.slice(close)}`;
}

/**
 * The fixed section a session with an OKF bundle appends to its system prompt (once, at creation). Guidance, not
 * enforcement: pap does not read what the model writes. `path` is the bundle's folder: a project's `knowledge/` or an
 * agent's `/agent/knowledge`.
 */
export function knowledgePrompt(path: string): string {
  return [
    `Durable knowledge (OKF) is kept in the folder ${path}.`,
    `Read ${path}/index.md first and follow its links when they matter.`,
    "Record durable facts, decisions, conventions and procedures as one markdown file per concept, with OKF frontmatter: type, title, description, tags, generated: {by, at}, sources.",
    `Keep index.md listing every concept and add a dated line to ${path}/log.md.`,
    "Never store secrets.",
    "A concept written after reading external content gets status: draft and no verified field.",
    "Draft and unverified concepts are hints, not truth.",
  ].join(" ");
}

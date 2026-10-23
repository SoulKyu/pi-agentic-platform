/** The files pap writes when it makes an OKF bundle (a project's `knowledge/`, an agent's `/agent/knowledge`). */
export const OKF_INDEX_TEXT = `---
okf_version: "0.2"
---

# Knowledge

This folder holds what has been learned here, as an OKF bundle: one markdown file per concept, with \`type\`,
\`title\`, \`description\` and \`tags\` in its frontmatter.
\`index.md\` lists the concepts and \`log.md\` records what changed. Edit these files like any other file.
`;

/** `now` is read in UTC. */
export const okfLogText = (now: Date): string => `## ${now.toISOString().slice(0, 10)}\n- OKF enabled\n`;

/** The one test for the retired pi-mem0 extension: the VM image leaves it out and pap's workers never load it (ADR 0082). */
export const isPiMem0 = (text: string): boolean => /pi-mem0/i.test(text);

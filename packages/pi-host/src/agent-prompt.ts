/** What the agent's system prompt is built from (M11R55). */
export interface AgentPromptFacts {
  readonly name: string;
  /** The agent's home folder. */
  readonly home: string;
  /** The owner's role text; empty adds no "Role:" part. */
  readonly role: string;
  /** The sandbox's network: null when the agent has no sandbox. */
  readonly network: boolean | null;
  /** An isolated task's scratch folder (its working folder); null for a thread. */
  readonly scratch: string | null;
}

/**
 * The text appended once to the system prompt of an agent's session, at session creation like `UNTRUSTED_RULE` (Pi's session
 * files do not store the prompt, so it is rebuilt at every start). Fixed English: only the name, the folders and the owner's
 * role vary, and the role comes last.
 */
export function agentPrompt(facts: AgentPromptFacts): string {
  const { name, home, role, network, scratch } = facts;
  const parts = [
    `You are ${name}, a long-term agent of this pap instance. Your home folder is ${home}; keep durable notes in MEMORY.md there. Commit your own work in the home with Conventional Commits; never add a remote or push.`,
  ];
  if (network !== null)
    parts.push(
      `Your shell runs in a sandbox: only ${scratch === null ? "your home" : "your scratch folder"} is writable, the network is ${network ? "on" : "off"}, and your secrets are environment variables.`,
    );
  if (scratch !== null)
    parts.push(
      `This is an isolated task: your home is read-only; write your files in ${scratch}, which is your working folder. Your thread reads them as external content; report what matters in your last message.`,
    );
  const body = parts.join(" ");
  return role === "" ? body : `${body}\n\nRole:\n${role}`;
}

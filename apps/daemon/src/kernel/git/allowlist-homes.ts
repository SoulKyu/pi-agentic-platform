import type { SubcommandRule } from "./allowlist.ts";

/**
 * M11's one addition (M11R46): the first commit of an agent's home. `init` makes the repository in the runner's root with
 * no template (no hook is copied from the owner's `init.templateDir`) on `main`; the identity is written to the new
 * repository's own config by the caller, and `add` and `commit` are M9's rules over the home's git dir
 * (`isAgentGitDir`). Nothing else of a home is run by pap (ADR 0050).
 */
export const HOME_SUBCOMMANDS: Readonly<Record<string, SubcommandRule>> = {
  init: {
    options: ["--initial-branch=main", "--template="],
    required: ["--initial-branch=main", "--template="],
    positional: false,
  },
};

import { useMemo } from "react";
import {
  chordJoiner,
  chordTokens,
  detectPlatform,
  keyNames,
  useKeybindingsStore,
} from "../../features/commands/index.ts";
import { useT } from "../../i18n/index.ts";

/** The keys of a command's first effective binding, formatted for this platform; empty when it has none. */
export function useShortcut(command: string): {
  readonly keys: readonly string[];
  readonly joiner: "" | "+";
} {
  const t = useT();
  const rules = useKeybindingsStore((state) => state.rules);
  return useMemo(() => {
    const platform = detectPlatform();
    const rule = rules.find((candidate) => candidate.command === command);
    return {
      keys: rule ? chordTokens(rule.chord, platform, keyNames(t)) : [],
      joiner: chordJoiner(platform),
    };
  }, [rules, command, t]);
}

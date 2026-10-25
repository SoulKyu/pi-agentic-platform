import { Heading, Kbd } from "@pap/ui";
import { Dialog } from "@pap/ui/overlays";
import { useT, type MessageKey } from "../../i18n/index.ts";
import { COMMANDS, type CommandGroup } from "./defaults.ts";
import type { Platform } from "./keys.ts";
import { chordJoiner, chordTokens, keyNames } from "./labels.ts";
import { useKeybindingsStore } from "./keybindings-store.ts";

const GROUPS: readonly { readonly id: CommandGroup; readonly titleKey: MessageKey }[] = [
  { id: "navigation", titleKey: "commands.group.navigation" },
  { id: "tabs", titleKey: "commands.group.tabs" },
  { id: "panes", titleKey: "commands.group.panes" },
  { id: "session", titleKey: "commands.group.session" },
  { id: "agents", titleKey: "commands.group.agents" },
  { id: "app", titleKey: "commands.group.app" },
];

interface ShortcutsHelpProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly platform: Platform;
}

/** The effective bindings, built from the merged rules so the list is never out of date. */
export default function ShortcutsHelp({ open, onOpenChange, platform }: ShortcutsHelpProps) {
  const t = useT();
  const rules = useKeybindingsStore((state) => state.rules);
  const names = keyNames(t);
  const sections = GROUPS.map((group) => ({
    ...group,
    entries: COMMANDS.filter((command) => command.group === group.id).flatMap((command) => {
      const rule = rules.findLast((candidate) => candidate.command === command.id);
      return rule ? [{ command, rule }] : [];
    }),
  })).filter((section) => section.entries.length > 0);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("commands.help.title")}
      closeLabel={t("ui.close")}
    >
      <div className="flex flex-col gap-s3 p-s3">
        {sections.map((section) => (
          <section key={section.id} data-group={section.id} className="flex flex-col gap-s1">
            <Heading level={3} variant="card">
              {t(section.titleKey)}
            </Heading>
            <ul className="flex flex-col gap-s1">
              {section.entries.map(({ command, rule }) => (
                <li
                  key={command.id}
                  data-command={command.id}
                  className="flex items-center justify-between gap-s2 text-ui"
                >
                  <span>{t(command.titleKey, command.titleVars)}</span>
                  <Kbd keys={chordTokens(rule.chord, platform, names)} joiner={chordJoiner(platform)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import type { CommandMenuProps } from "./CommandMenu.tsx";
import { SkillChip } from "./SkillChip.tsx";

// The listbox is a chunk of its own, fetched the first time a `/` or `$` finds something to offer.
const loadCommandMenu = () => import("./CommandMenu.tsx");

export interface CommandsMountProps {
  /** The skill the text starts with, shown as a chip. */
  readonly skill: string | null;
  removeSkill(): void;
  readonly open: boolean;
  readonly menu: CommandMenuProps;
  close(): void;
}

/** What `useComposerCommands` puts on the page: the skill chip, and the lazy listbox while it is open. */
export function CommandsMount({ skill, removeSkill, open, menu, close }: CommandsMountProps) {
  const lazyText = useLazyFailureText();
  return (
    <>
      {skill === null ? null : <SkillChip skill={skill} onRemove={removeSkill} />}
      <LazyPanel load={loadCommandMenu} open={open} props={menu} text={lazyText} onFailed={close} />
    </>
  );
}

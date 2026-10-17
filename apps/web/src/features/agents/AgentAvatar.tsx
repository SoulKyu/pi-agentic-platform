import type { AgentSummary } from "@pap/contracts";
import { Avatar, type AvatarStyle } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { railPresence, unreadLabel } from "./rail.vm.ts";

/**
 * An agent's avatar (DESIGN §9.1): initials in the account's style, a presence dot and the unread badge. The dot is
 * colour only; the state word is in the name of the control that holds the avatar (M11R108).
 */
export function AgentAvatar({
  agent,
  avatarStyle,
}: {
  readonly agent: AgentSummary;
  readonly avatarStyle: AvatarStyle;
}) {
  const t = useT();
  return (
    <Avatar
      initials={agent.initials}
      name={agent.name}
      avatarStyle={avatarStyle}
      presence={railPresence(agent.state)}
      badge={{ count: agent.unread, label: unreadLabel(agent, t) }}
    />
  );
}

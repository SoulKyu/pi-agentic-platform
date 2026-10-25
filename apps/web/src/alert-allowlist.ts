/** Files that keep their own role="alert", each with its reason (DESIGN.md §11). Everything else uses InlineError or Banner. */
export const ALERT_ALLOWLIST: Readonly<Record<string, string>> = {
  "features/sessions/Transcript.tsx":
    "the red data-failure block is a transcript item, with a title and a next step",
  "features/terminal/TerminalPane.tsx": "the close confirmation is a question, not a failure",
  "features/notifications/DevicesList.tsx": "the revoke confirmation is a question, not a failure",
};

/** Files whose pink live regions wait for the person (a question, an approval, a count), each with its reason. */
export const PINK_ALLOWLIST: Readonly<Record<string, string>> = {
  "features/lanes/ArchiveDialog.tsx":
    "branchKept waits for the person to delete the branch, and the force confirmation is a question",
  "features/lanes/LaneScreen.tsx": "branchKept waits for the person to delete the branch",
  "features/settings/ClaudeToken.tsx": "a missing token waits for the person to paste one",
  "features/auth/InviteScreen.tsx": "the signed-in confirmation is a question the person answers",
  "features/auth/TokenCreate.tsx": "a risky permission waits for the person to confirm it",
  "features/agents/AgentForm.tsx": "the step-up note waits for the person to type their password to save",
  "gallery/sections/DisplayFigures.tsx": "a specimen of the pink tone in the gallery, not a failure",
  "features/github/GithubSettings.tsx":
    "created, reconnect, permission and origin notes wait for the person to act",
};

import type { ForkPoint } from "@pap/contracts";
import { IconSplit, IconTemplate, IconUndo, MessageAction, MessageActions, InlineError } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import "../../i18n/register-reply-tools.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { useRole } from "../../lib/role-context.ts";
import { getRuntime } from "../../runtime/index.ts";
import { deviceStorage, saveDraft } from "../../stores/drafts.ts";
import { BranchSwitcher } from "./BranchSwitcher.tsx";
import { branchChoicesFor } from "./branches.vm.ts";
import { useAction, type Track } from "./use-action.ts";

// One function for the life of the page, so the lazy component is shared.
const loadTemplateDialog = () =>
  import("./dialogs/SaveTemplateDialog.tsx").then((module) => ({ default: module.SaveTemplateDialog }));

/** What a user row needs to offer "Fork from here" and "Edit from here". */
export interface RowActions {
  readonly sessionId: string;
  /** The agent works, or another structural call of the screen is in flight: both buttons wait. */
  readonly blocked: boolean;
  readonly track: Track;
  /** The session runs in a project's box: its file is the VM's, so there is no fork (the daemon refuses it). */
  readonly inBox?: boolean;
  /** The text "Edit from here" puts in the composer. */
  readonly onEdit: (text: string) => void;
  /** The session's fork points, for the branch switcher of a user row. */
  readonly branches?: readonly ForkPoint[];
  /** Says something politely to assistive technology (the branch a switch landed on). */
  readonly announce?: (key: "branch.group", vars: { index: number; total: number }) => void;
}

/** The actions of one of your messages: step between branches, fork from it, edit from it. */
export function RowButtons({
  entryId,
  actions,
  text,
  unverified,
}: {
  entryId: string;
  actions: RowActions;
  /** The row's text, for "Save as template". */
  text: string;
  /** A user entry the VM wrote and pap did not send: it is not offered as a template. */
  unverified: boolean;
}) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const owner = useRole() === "owner";
  const [saving, setSaving] = useState(false);
  const runtime = getRuntime();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const fork = useAction(actions.track, setError);
  const edit = useAction(actions.track, setError);
  const { sessionId } = actions;
  const switchBranch = useAction(actions.track, setError);
  /** One navigation for both buttons; an extension's hook can cancel it, and that is said, not ignored. */
  const goTo = async (targetId: string) => {
    const moved = await runtime.rpc.call(
      "sessions.navigate",
      { sessionId, targetId },
      { commandId: runtime.rpc.newCommandId() },
    );
    if (moved.cancelled) setError(t("navigation.cancelled"));
    return moved;
  };
  const wait = actions.blocked || fork.busy || edit.busy || switchBranch.busy;
  const choices = branchChoicesFor(actions.branches ?? [], entryId);
  return (
    <>
      <MessageActions label={t("row.actions")}>
        {choices ? (
          <BranchSwitcher
            choices={choices}
            disabled={wait}
            onGo={(targetId, index) =>
              void switchBranch.run(async () => {
                const moved = await goTo(targetId);
                if (!moved.cancelled) actions.announce?.("branch.group", { index, total: choices.total });
              })
            }
          />
        ) : null}
        {actions.inBox === true ? null : (
          <MessageAction
            label={fork.slow ? t("actions.working") : t("row.fork")}
            icon={IconSplit}
            disabled={wait}
            onClick={() =>
              void fork.run(async () => {
                const forked = await runtime.rpc.call(
                  "sessions.fork",
                  { sessionId, entryId },
                  { commandId: runtime.rpc.newCommandId() },
                );
                saveDraft(deviceStorage(), forked.sessionId, forked.text);
                await navigate({ to: "/s/$sessionId", params: { sessionId: forked.sessionId } });
              })
            }
          />
        )}
        {owner && !unverified ? (
          <MessageAction
            label={t("reply.template.action")}
            icon={IconTemplate}
            onClick={() => setSaving(true)}
          />
        ) : null}
        <MessageAction
          label={edit.slow ? t("actions.working") : t("row.edit")}
          icon={IconUndo}
          disabled={wait}
          onClick={() =>
            void edit.run(async () => {
              const moved = await goTo(entryId);
              if (!moved.cancelled && moved.editorText !== undefined) actions.onEdit(moved.editorText);
            })
          }
        />
      </MessageActions>
      <LazyPanel
        text={lazyText}
        load={loadTemplateDialog}
        open={saving}
        props={{ text, onClose: () => setSaving(false) }}
        onFailed={() => setSaving(false)}
      />
      {error ? <InlineError announce="action">{error}</InlineError> : null}
    </>
  );
}

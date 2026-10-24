import "../../i18n/register-sidebar.ts";
import { type ProjectSummary, SHELL_LIMITS } from "@pap/contracts";
import { IconButton, IconMore, TextField } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type MessageKey, useLazyFailureText, useT } from "../../i18n/index.ts";
import { hasCommand, runCommand } from "../../lib/command-registry.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useProjectSettingsRequest } from "../../stores/project-settings-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useMenuFocus, wantFocus } from "./menu-focus.ts";
import { organiseProject } from "./organise.ts";
import { organiseDeps, say } from "./SessionMenu.tsx";

const failed = { result: "refused", code: "internal" } as const;
const clipName = (value: string): string => [...value].slice(0, SHELL_LIMITS.projectName).join("");
const keyOf = (project: ProjectSummary): string => `project:${project.id}`;

interface ProjectMenuProps {
  readonly project: ProjectSummary;
  /** The projects as the tree shows them, first first: Move up and Move down are relative to it. */
  readonly order: readonly ProjectSummary[];
  /** False while the tree is filtered: the shown order is then not the whole order. */
  readonly movable: boolean;
  onRename(): void;
  /** After "New session here" went to the start. */
  onNewSession?(): void;
}

/** The "⋯" menu of a project heading: New session here, New lane, Rename, Move up, Move down (M4R98, no drag and drop, M4R99). */
export function ProjectMenu({ project, order, movable, onRename, onNewSession }: ProjectMenuProps) {
  const t = useT();
  const navigate = useNavigate();
  const lazyText = useLazyFailureText();
  const pending = useShellStore((state) => state.view.pending.size > 0);
  const key = keyOf(project);
  useMenuFocus(key, pending);
  const at = order.findIndex((other) => other.id === project.id);

  const move = (before: string | null) => {
    wantFocus(key);
    organiseProject({ project, change: { kind: "move", before }, order }, organiseDeps()).then(
      (outcome) => {
        if (outcome.result === "busy") wantFocus(null);
        say(outcome, t);
      },
      () => say(failed, t),
    );
  };
  const item = (id: string, label: MessageKey, onSelect: () => void): MenuItem => ({
    id,
    label: t(label),
    onSelect,
  });
  const items = [
    item("new", "sidebar.action.newHere", () => {
      // The person starts from this project: the home reads the choice for its folder and Recent list.
      useCurrentProject.getState().startHere(project.id);
      onNewSession?.();
      void navigate({ to: "/" });
    }),
    item("rename", "sidebar.action.rename", onRename),
  ];
  // The new-lane dialog registers `lanes.new` when it mounts (Task 21); the project it opens for is this one.
  if (hasCommand("lanes.new")) {
    items.splice(
      1,
      0,
      item("new-lane", "sidebar.action.newLane", () => {
        useCurrentProject.getState().startHere(project.id);
        runCommand("lanes.new");
      }),
    );
  }
  if (project.kind === "box") {
    items.push(
      item("settings", "sidebar.action.projectSettings", () =>
        useProjectSettingsRequest.getState().ask(project.id),
      ),
    );
  }
  if (movable && at > 0) {
    items.push(item("up", "sidebar.action.moveUp", () => move((order[at - 1] as ProjectSummary).id)));
  }
  if (movable && at !== -1 && at < order.length - 1) {
    items.push(item("down", "sidebar.action.moveDown", () => move(order[at + 2]?.id ?? null)));
  }

  return (
    <LazyMenu
      label={t("sidebar.menu.project")}
      closeLabel={t("ui.close")}
      text={lazyText}
      items={items}
      trigger={(ask) => (
        <IconButton
          icon={IconMore}
          label={t("sidebar.menu.project")}
          size="sm"
          disabled={pending}
          data-menu-key={key}
          onClick={ask}
        />
      )}
    />
  );
}

interface ProjectRenameProps {
  readonly project: ProjectSummary;
  readonly order: readonly ProjectSummary[];
  onDone(): void;
}

/** The heading turned into a field: Enter saves, Escape cancels (and never stops a run, M3 P3's key rule). */
export function ProjectRename({ project, order, onDone }: ProjectRenameProps) {
  const t = useT();
  const [draft, setDraft] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector("input")?.focus();
  }, []);

  const save = () => {
    const name = clipName(draft.trim());
    if (name === "") return setError(t("sidebar.rename.empty"));
    wantFocus(keyOf(project));
    onDone();
    if (name === project.name) return;
    organiseProject({ project, change: { kind: "rename", name }, order }, organiseDeps()).then(
      (outcome) => {
        if (outcome.result === "busy") wantFocus(null);
        say(outcome, t);
      },
      () => say(failed, t),
    );
  };

  return (
    <div
      ref={box}
      data-inline-edit
      className="min-w-0 flex-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Cancels the edit only: the page's Escape-to-Stop must not see it.
          event.preventDefault();
          event.stopPropagation();
          wantFocus(keyOf(project));
          onDone();
        } else if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          save();
        }
      }}
    >
      <TextField
        label={t("sidebar.rename.label")}
        name="project-name"
        value={draft}
        error={error}
        onChange={(value) => {
          setDraft(value);
          setError(null);
        }}
      />
    </div>
  );
}

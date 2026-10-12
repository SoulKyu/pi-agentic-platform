import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  COMMANDS,
  detectPlatform,
  hasCommand,
  keyNames,
  runCommand,
  useCommand,
  useKeybindingsStore,
} from "../../features/commands/index.ts";
import { pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { reportClientIssue } from "../../lib/report.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { buildPaletteItems } from "./palette-items.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { go } from "./tab-actions.ts";

const loadPalette = () => import("../../features/commands/palette/CommandPalette.tsx");

/** Owns `palette.toggle`. The palette and cmdk are fetched on first open, so none of it is in the initial bundle. */
export function PaletteHost() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useCommand("palette.toggle", () => setOpen((current) => !current));
  const rules = useKeybindingsStore((state) => state.rules);
  const tabs = useWorkspaceStore((state) => state.ws.tabs);
  const held = useShellStore((state) => state.view.sessions);
  const views = useViewLabels((state) => state.labels);

  const items = useMemo(
    () =>
      open
        ? buildPaletteItems({
            commands: COMMANDS,
            has: hasCommand,
            rules,
            platform: detectPlatform(),
            names: keyNames(t),
            tabs,
            sessions: [...held.values()],
            views,
            t,
            navigate: (item) => go(navigate, pathOfItem(item)),
            run: (id) => {
              try {
                runCommand(id);
              } catch {
                reportClientIssue("command_failed");
              }
            },
          })
        : [],
    [open, rules, tabs, held, views, t, navigate],
  );
  return (
    <LazyPanel
      text={lazyText}
      load={loadPalette}
      open={open}
      props={{ open, onOpenChange: setOpen, items }}
      onFailed={() => setOpen(false)}
    />
  );
}

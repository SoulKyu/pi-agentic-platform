import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { getRuntime } from "../../runtime/index.ts";
import { buildPaletteItems } from "./palette-items.ts";
import { useSessionsCache } from "./sessions-cache.ts";
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
  const sessions = useSessionsCache((state) => state.sessions);
  const runtime = getRuntime();

  useEffect(() => {
    if (!open) return;
    void useSessionsCache
      .getState()
      .refresh(runtime.rpc)
      .catch(() => reportClientIssue("sessions_list_failed"));
  }, [open, runtime]);

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
            sessions,
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
    [open, rules, tabs, sessions, t, navigate],
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

import type { ToolPreset } from "@pap/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { ProjectHome } from "../../features/home/ProjectHome.tsx";
import { lastPreset, rememberPreset } from "../../features/sessions/presets.vm.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyBoundary, notifyLazyFailure, useRetryableLazy } from "../../lib/lazy.tsx";
import { homeActions } from "./home-actions.ts";
import { useShortcut } from "./shortcut.ts";
import { useTasksFeed } from "./use-tasks-feed.ts";

// The picker (Select and its strings) is a chunk of its own: the home stays within the initial bundle.
const loadPicker = () => import("../../features/sessions/PresetPicker.tsx");

/**
 * The home pane (decision 85): the shell's side of `ProjectHome` — its actions, the chords it shows, the tool preset
 * field (another feature's), and the `tasks` stream, open while the home shows (§8).
 */
export function HomePane() {
  const navigate = useNavigate();
  const lazyText = useLazyFailureText();
  const { Lazy: Picker, attempt, retry } = useRetryableLazy(loadPicker);
  const [preset, setPreset] = useState<ToolPreset>(lastPreset);
  const layout = useAppearanceStore((state) => state.account.home);
  useTasksFeed(true);
  const actions = useMemo(() => homeActions(navigate), [navigate]);
  const lane = useShortcut("lanes.new");
  const search = useShortcut("palette.toggle");
  const help = useShortcut("shortcuts.help");
  const shortcuts = useMemo(() => ({ lane, search, help }), [lane, search, help]);
  return (
    <ProjectHome
      actions={actions}
      shortcuts={shortcuts}
      preset={preset}
      layout={layout}
      presetField={(disabled) => (
        <LazyBoundary
          resetKey={attempt}
          onError={(error) => {
            retry();
            notifyLazyFailure(error, lazyText);
          }}
        >
          <Picker
            value={preset}
            disabled={disabled}
            onChange={(next) => {
              setPreset(next);
              rememberPreset(next);
            }}
          />
        </LazyBoundary>
      )}
    />
  );
}

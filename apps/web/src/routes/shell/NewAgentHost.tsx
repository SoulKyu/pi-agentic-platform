import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCommand } from "../../features/commands/index.ts";
import { pathOfItem } from "../../features/workspace/index.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { go } from "./tab-actions.ts";

const loadDialog = () => import("./new-agent-entry.tsx").then((m) => ({ default: m.NewAgentEntry }));

/**
 * Owns `agents.new` (the rail's +, the home's action, ⌘K; Settings › Agents has its own button, M11R96). The dialog is
 * fetched on first open and mounted only while open. A new agent opens in its own tab.
 */
export function NewAgentHost() {
  const lazyText = useLazyFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useCommand("agents.new", () => setOpen(true));
  return (
    <LazyPanel
      text={lazyText}
      load={loadDialog}
      open={open}
      props={{
        onClose: () => setOpen(false),
        onCreated: (agent) => go(navigate, pathOfItem({ kind: "agent", id: agent.id })),
      }}
      onFailed={() => setOpen(false)}
    />
  );
}

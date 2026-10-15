import { Button, EmptyState } from "@pap/ui";
import { useState } from "react";
import "../../i18n/register-terminal.ts";
import "../../features/lanes/register-lanes-catalog.ts";
import { TerminalPane } from "../../features/terminal/TerminalPane.tsx";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { randomId } from "../../runtime/random-id.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";

/**
 * The terminal pane of a lane tab (M9R63): the newest running terminal of the lane's folder, else a button that starts
 * one there. It lives in the shell because it joins the terminal feature to a folder (features never import each other).
 */
export function LaneTerminal({ root }: { readonly root: string }) {
  const t = useT();
  const list = useTerminalStore((state) => state.view.list);
  const [chosen, setChosen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const running = list.filter((terminal) => terminal.cwd === root && terminal.status === "running");
  const current =
    chosen !== null && list.some((terminal) => terminal.id === chosen)
      ? chosen
      : (running.at(-1)?.id ?? null);

  if (current !== null) {
    return <TerminalPane key={current} id={current} onClose={() => setChosen(null)} onOpen={setChosen} />;
  }
  const open = (): void => {
    setFailed(false);
    getRuntime()
      .rpc.call("terminal.create", { requestId: randomId(16), cwd: root, cols: 80, rows: 24 })
      .then(
        (created) => setChosen(created.terminalId),
        () => setFailed(true),
      );
  };
  return (
    <EmptyState
      title={t("terminal.pane.title")}
      purpose={failed ? t("terminal.new.failed") : t("lanes.terminal.none")}
      action={
        <Button variant="primary" onClick={open}>
          {t("terminal.action.newHere")}
        </Button>
      }
    />
  );
}

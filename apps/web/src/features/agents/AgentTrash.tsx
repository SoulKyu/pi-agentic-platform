import "./register-agent-catalog.ts";
import { Button, Heading } from "@pap/ui";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { visibleName } from "../../lib/visible-name.ts";
import { getRuntime } from "../../runtime/index.ts";
import { usePurgeTrash } from "./use-purge-trash.ts";

interface TrashEntry {
  readonly agentId: string;
  readonly name: string;
}

/**
 * Settings › Agents › Deleted agents (J1b): a deleted agent's disk is kept 7 days (RT-40), and "Purge now"
 * stays here after the delete note is gone. Nothing is drawn while the trash is empty or cannot be read.
 */
export function AgentTrash() {
  const t = useT();
  const purge = usePurgeTrash();
  const [entries, setEntries] = useState<readonly TrashEntry[]>([]);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("agents.trash", {})
      .then(
        (answer) => {
          if (live) setEntries(answer.agents);
        },
        () => {
          if (live) setEntries([]);
        },
      );
    return () => {
      live = false;
    };
  }, []);
  if (entries.length === 0) return null;
  return (
    <section data-slot="agents-trash" aria-labelledby="agents-trash-title" className="flex flex-col gap-s3">
      <Heading level={2} variant="group" id="agents-trash-title">
        {t("agentVm.trash.title")}
      </Heading>
      <p className="text-ui text-muted">{t("agentVm.trash.hint")}</p>
      <ul className="flex flex-col gap-s2">
        {entries.map((entry) => {
          const name = visibleName(entry.name);
          return (
            <li key={entry.agentId} className="flex items-center justify-between gap-s2">
              <span className="min-w-0 break-words text-ui text-fg">{name}</span>
              <Button
                aria-label={t("agentVm.trash.purgeOne", { name })}
                onClick={() =>
                  void purge(entry.agentId, name).then((purged) => {
                    if (purged) setEntries((now) => now.filter((one) => one.agentId !== entry.agentId));
                  })
                }
              >
                {t("agentVm.purge")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

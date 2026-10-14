import type { PluginsListResult, SkillsListResult } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { skillsFailureText } from "./skills.vm.ts";

/**
 * `skills.list`, `plugins.list` and the folder's trust need for the project, read again on `reload`. A later answer
 * replaces an earlier one, an answer for an unmounted screen is dropped, and the last good lists stay on screen while
 * the next ones load or fail. The trust read is a hint: when it fails the notice is simply not shown.
 */
export function useSkillsData(root: string | undefined) {
  const [skills, setSkills] = useState<SkillsListResult | null>(null);
  const [plugins, setPlugins] = useState<PluginsListResult | null>(null);
  const [needsTrust, setNeedsTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    const rpc = getRuntime().rpc;
    const where = root === undefined ? {} : { cwd: root };
    Promise.all([rpc.call("skills.list", where), rpc.call("plugins.list", where)]).then(
      ([skillsAnswer, pluginsAnswer]) => {
        if (!current) return;
        setSkills(skillsAnswer);
        setPlugins(pluginsAnswer);
        setError(null);
      },
      (failure: unknown) => {
        if (current) setError(skillsFailureText(failure, "list"));
      },
    );
    if (root !== undefined)
      rpc.call("trust.status", { cwd: root }).then(
        (status) => {
          if (current) setNeedsTrust(status.requiresTrust === true && status.decision !== true);
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [loads, root]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return { skills, plugins, needsTrust, error, reload };
}

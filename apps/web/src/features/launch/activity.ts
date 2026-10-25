import { useLaneStore } from "../../stores/lane-store.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";

/**
 * What is in progress, as a number: every live launch (a start, an image build, a session's box) and every lane being set
 * up. Only what a global feed delivers: waiting tasks show on their cards, clones have no client feed. A number, so the shell
 * does not render with each second of a launch.
 */
export function useActivityCount(): number {
  const launches = useLaunchStore((state) => state.view.launches.size);
  const lanes = useLaneStore((state) => countCreating(state.view.lanes));
  return launches + lanes;
}

const countCreating = (lanes: ReadonlyMap<string, { readonly state: string }>): number => {
  let count = 0;
  for (const lane of lanes.values()) if (lane.state === "creating") count += 1;
  return count;
};

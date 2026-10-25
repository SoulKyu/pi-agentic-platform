import type { LaunchRegistry } from "../../../kernel/launches.ts";

/**
 * A registry that logs what its handles are told, in order: `checks:running`, `wait:image_build`, `end:ok` or `end:<code>`.
 * Every handle shares the log; `opened` counts the `open` calls.
 */
export function recordLaunches(registry: LaunchRegistry): {
  readonly registry: LaunchRegistry;
  readonly log: string[];
  readonly opened: () => number;
} {
  const log: string[] = [];
  let opened = 0;
  return {
    log,
    opened: () => opened,
    registry: {
      ...registry,
      open(input) {
        opened += 1;
        const handle = registry.open(input);
        return {
          id: handle.id,
          stopped: () => handle.stopped(),
          step(step, state, detail) {
            log.push(`${step}:${state}`);
            handle.step(step, state, detail);
          },
          wait(waiting) {
            log.push(`wait:${waiting?.reason ?? "none"}`);
            handle.wait(waiting);
          },
          end(ok, code) {
            log.push(ok ? "end:ok" : `end:${code ?? "?"}`);
            handle.end(ok, code);
          },
        };
      },
    },
  };
}

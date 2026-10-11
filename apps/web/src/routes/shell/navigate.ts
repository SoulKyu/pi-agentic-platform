import type { useNavigate } from "@tanstack/react-router";
import { pathOfItem, type ItemRef } from "../../features/workspace/index.ts";

/** UI actions navigate; the URL is the source of the active item and the shell follows it. */
export function navigateTo(navigate: ReturnType<typeof useNavigate>, item: ItemRef): Promise<void> {
  return navigate({ to: pathOfItem(item) });
}

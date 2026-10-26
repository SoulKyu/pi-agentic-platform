import "../../../i18n/register-settings-availability.ts";
import "../register-catalog.ts";
import { mount } from "../../../testing/dom.ts";
import { useOverview } from "../use-overview.ts";
import { AvailabilitySection } from "./AvailabilitySection.tsx";

export * from "./availability-world.ts";

function Host() {
  const list = useOverview();
  return list.value ? (
    <AvailabilitySection overview={list.value} loading={list.loading} reloadOverview={list.reload} />
  ) : null;
}

export const showAvailability = () => mount(<Host />);

export const switchOf = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('[data-slot="switch"]')]
    .filter((one) => one.querySelector("label")?.textContent === label)
    .map((one) => one.querySelector('[role="switch"]') as HTMLButtonElement)[0] as HTMLButtonElement;

export const previewIds = (container: ParentNode): string[] =>
  [...container.querySelectorAll("[data-preview] [data-preview-model]")].map(
    (one) => one.getAttribute("data-preview-model") ?? "",
  );

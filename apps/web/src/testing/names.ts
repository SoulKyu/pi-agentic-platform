const HEADINGS = "h1, h2, h3, h4, h5, h6";
const LANDMARKS =
  "nav, main, [role='navigation'], [role='main'], [role='region'], section[aria-label], section[aria-labelledby]";

function nameOf(element: Element): string {
  const ids = element.getAttribute("aria-labelledby");
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => (element.getRootNode() as ParentNode).querySelector(`[id="${id}"]`)?.textContent ?? "")
      .join(" ");
    return text.replace(/\s+/g, " ").trim();
  }
  const label = element.getAttribute("aria-label");
  if (label) return label.trim();
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function repeated(elements: readonly Element[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const element of elements) {
    const name = nameOf(element);
    if (name === "") continue;
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return [...twice];
}

/** Each accessible name shared by two headings, two landmarks, or two buttons with one parent. */
export function duplicateNames(root: ParentNode): string[] {
  const found = new Set<string>();
  for (const name of repeated([...root.querySelectorAll(HEADINGS)])) found.add(name);
  for (const name of repeated([...root.querySelectorAll(LANDMARKS)])) found.add(name);
  const parents = new Set<Element>();
  for (const button of root.querySelectorAll("button"))
    if (button.parentElement) parents.add(button.parentElement);
  for (const parent of parents) {
    for (const name of repeated([...parent.children].filter((child) => child.tagName === "BUTTON")))
      found.add(name);
  }
  return [...found];
}

/** The radiogroup of a Segmented, found by its visible (or screen-reader) label. */
export function segmentedGroup(root: ParentNode, label: string): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('[data-slot="segmented"]')].find(
      (group) => nameOf(group) === label,
    ) ?? null
  );
}

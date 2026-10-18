/**
 * The one place that names the project repository (AGPL section 13, ADR 0077). A fork edits this constant: the update
 * feed's allowed path, the push subject fallback and the "Source code" link in Settings all follow it.
 */
export const PROJECT_REPO = "SoulKyu/pi-agentic-platform";
export const PROJECT_URL = `https://github.com/${PROJECT_REPO}`;

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
/** The version a checkout carries before release-please bumps it: no tag exists for it. */
const UNRELEASED_VERSION = "0.0.0";

/** Where the Corresponding Source of a running version lives: its tag for a release, else the repository root. */
export function sourceUrl(version: string | null): string {
  if (version === null || version === UNRELEASED_VERSION || !RELEASE_VERSION.test(version))
    return PROJECT_URL;
  return `${PROJECT_URL}/tree/v${version}`;
}

// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { githubStatus } from "../../testing/github-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { GithubSettings } from "./GithubSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const go = vi.fn();
const stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));

async function show(status: ReturnType<typeof githubStatus>) {
  bed.handlers["github.status"] = () => ({ status });
  const page = await mount(
    <TooltipProvider>
      <GithubSettings stepUp={stepUp as unknown as StepUpRunner} go={go} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  go.mockReset();
  stepUp.mockClear();
});

describe("Settings › GitHub", () => {
  it.each([
    ["absent", { state: "absent", app: null, login: null }, ["CREATE THE GITHUB APP"], "No GitHub App yet."],
    ["created", { state: "created", login: null }, ["AUTHORIZE", "DELETE THE APP"], "pap-host-ab12 exists"],
    ["connected", { state: "connected" }, ["DISCONNECT", "DELETE THE APP"], "Connected as octo."],
    [
      "permission missing",
      { state: "connected", permissionMissing: true },
      ["OPEN GITHUB", "RECONNECT", "DISCONNECT", "DELETE THE APP"],
      "Set “SSH signing keys: Read and write” in the App's permissions on GitHub",
    ],
    [
      "reconnect",
      { state: "reconnect" },
      ["RECONNECT", "DELETE THE APP"],
      "GitHub needs you to sign in again: your authorization expired.",
    ],
  ] as const)("each state shows its copy and actions: %s", async (_name, patch, buttons, words) => {
    const container = await show(githubStatus(patch as never));
    expect(text(container)).toContain(words);
    for (const label of buttons) expect(hasButton(container, label)).toBe(true);
  });

  it("says the callback URL to paste when pap is reached at another address", async () => {
    const container = await show(
      githubStatus({
        app: {
          slug: "pap-host-ab12",
          htmlUrl: "https://github.com/apps/pap-host-ab12",
          callbackOrigin: "http://other:3000",
          originMatches: false,
        },
      }),
    );
    expect(text(container)).toContain(
      `Paste this callback URL in the App's settings on GitHub: ${window.location.origin}/github/app/authorized`,
    );
  });

  it("says its words in French", async () => {
    setLocale("fr");
    const container = await show(githubStatus({ state: "absent", app: null, login: null }));
    expect(text(container)).toContain("Aucune GitHub App pour l'instant.");
    expect(hasButton(container, "CRÉER LA GITHUB APP")).toBe(true);
  });

  it("Create goes to the daemon's page, in this tab", async () => {
    bed.handlers["github.startCreate"] = () => ({
      postUrl: `${window.location.origin}/github/app/new?state=` + "a".repeat(32),
      manifest: "{}",
      state: "a".repeat(32),
    });
    const container = await show(githubStatus({ state: "absent", app: null, login: null }));
    await click(button(container, "CREATE THE GITHUB APP"));
    await settle();
    expect(go).toHaveBeenCalledExactlyOnceWith(
      `${window.location.origin}/github/app/new?state=` + "a".repeat(32),
    );
  });

  it.each([
    "https://evil.test/github/app/new?state=x",
    `${"http://github.com"}/github/app/new`,
    "javascript:alert(1)",
    "data:text/html,x",
    `${window.location.origin}/other`,
  ])("Create refuses to navigate to %s and says so", async (postUrl) => {
    bed.handlers["github.startCreate"] = () => ({ postUrl, manifest: "{}", state: "a".repeat(32) });
    const container = await show(githubStatus({ state: "absent", app: null, login: null }));
    await click(button(container, "CREATE THE GITHUB APP"));
    await settle();
    expect(go).not.toHaveBeenCalled();
    expect(text(container)).toContain("GitHub is not set up for pap");
  });

  it.each([
    "https://evil.test/login/oauth/authorize",
    "https://github.com.evil.test/login",
    "http://github.com/login",
    "javascript:alert(1)",
    "data:text/html,x",
  ])("Authorize refuses to navigate to %s", async (url) => {
    bed.handlers["github.authorizeUrl"] = () => ({ url });
    const container = await show(githubStatus({ state: "created", login: null }));
    await click(button(container, "AUTHORIZE"));
    await settle();
    expect(go).not.toHaveBeenCalled();
    expect(text(container)).toContain("GitHub is not set up for pap");
  });

  it("OPEN GITHUB goes to the App's permissions page, under /settings/apps", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const container = await show(githubStatus({ permissionMissing: true }));
    await click(button(container, "OPEN GITHUB"));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/settings/apps/pap-host-ab12/permissions",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("Authorize goes to github.com", async () => {
    bed.handlers["github.authorizeUrl"] = () => ({ url: "https://github.com/login/oauth/authorize?x=1" });
    const container = await show(githubStatus({ state: "created", login: null }));
    await click(button(container, "AUTHORIZE"));
    await settle();
    expect(go).toHaveBeenCalledExactlyOnceWith("https://github.com/login/oauth/authorize?x=1");
  });

  it("OPEN GITHUB is offered only for an address on github.com", async () => {
    const container = await show(
      githubStatus({
        permissionMissing: true,
        app: {
          slug: "a",
          htmlUrl: "https://evil.test/apps/a",
          callbackOrigin: "http://localhost:3000",
          originMatches: true,
        },
      }),
    );
    expect(hasButton(container, "OPEN GITHUB")).toBe(false);
    expect(text(container)).toContain("GitHub is not set up for pap");
  });

  it("Disconnect calls github.disconnect and reads the status again", async () => {
    const container = await show(githubStatus());
    await click(button(container, "DISCONNECT"));
    await settle();
    expect(bed.called("github.disconnect")).toHaveLength(1);
    expect(bed.called("github.status")).toHaveLength(2);
  });

  it("delete asks the step-up, and Cancel does not delete", async () => {
    const container = await show(githubStatus());
    await click(button(container, "DELETE THE APP"));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("pap forgets the App and every GitHub token it holds.");
    await click(button(dialog, "Cancel"));
    expect(stepUp).not.toHaveBeenCalled();
    await click(button(container, "DELETE THE APP"));
    const again = document.querySelector('[role="dialog"]') as HTMLElement;
    const danger = button(again, "DELETE THE APP");
    expect(danger.className).toContain("border-err");
    await click(danger);
    await settle();
    expect(stepUp).toHaveBeenCalledOnce();
    expect(bed.called("github.forget")).toHaveLength(1);
    expect(bed.called("github.forget")[0]?.options?.commandId).toBe("step-cmd-1");
  });

  it("a cancelled password prompt deletes nothing", async () => {
    stepUp.mockResolvedValueOnce(null);
    const container = await show(githubStatus());
    await click(button(container, "DELETE THE APP"));
    await click(button(document.querySelector('[role="dialog"]') as HTMLElement, "DELETE THE APP"));
    await settle();
    expect(bed.called("github.forget")).toEqual([]);
  });
});

// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const onClose = vi.fn();
const stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));

async function open(phase: "stopped" | "running" = "running") {
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject(phase)] }));
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={stepUp as unknown as StepUpRunner}>
        <ProjectSettings projectId="b1" onClose={onClose} />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
}
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "running" }) });
  bed.handlers["projects.github"] = () => ({ github: githubView({ link: null }) });
  bed.handlers["github.repositories"] = () => ({ repositories: [] });
  bed.handlers["projects.setBox"] = (params) => ({
    box: boxView({ phase: "running", ...(params as object) }),
  });
  useShellStore.getState().reset();
  onClose.mockReset();
  navigate.mockReset();
  stepUp.mockClear();
});

describe("project settings", () => {
  it("shows the sections with the saved values", async () => {
    await open();
    const body = text(document.body);
    for (const label of ["BOX", "RESOURCES", "HOSTS", "PACKAGES"]) expect(body).toContain(label);
    expect(field(document.body, "Memory (MiB)").value).toBe("2048");
    expect(field(document.body, "Disk (MiB)").value).toBe("8192");
    expect(field(document.body, "Hosts, one per line").value).toBe("api.example.com");
    expect(body).toContain("In the box image");
    expect(body).toContain("git");
    expect(body).not.toContain("Asked by");
    expect(button(document.body, "RESTART BOX")).toBeDefined();
  });

  it("says the hosts belong to this project and come on top of the owner's list", async () => {
    await open();
    expect(text(document.body)).toContain(
      "These hosts belong to this project. Its box reaches them on top of your own list (Settings › Policy).",
    );
  });

  it("saves changed resources and hosts", async () => {
    await open();
    await typeInto(field(document.body, "Memory (MiB)"), "4096");
    await typeInto(field(document.body, "Hosts, one per line"), "api.example.com\n*.example.org\n");
    await click(button(document.body, "SAVE"));
    await settle();
    expect(bed.called("projects.setBox")[0]?.params).toEqual({
      projectId: "b1",
      resources: { memoryMb: 4096, cpus: 2, diskMb: 8192 },
      hosts: ["api.example.com", "*.example.org"],
    });
  });

  it("a smaller disk is refused", async () => {
    await open();
    await typeInto(field(document.body, "Disk (MiB)"), "4096");
    await click(button(document.body, "SAVE"));
    await settle();
    expect(bed.called("projects.setBox")).toEqual([]);
    expect(text(document.body)).toContain("The disk cannot go below its saved size");
  });

  it("refuses a host that is not a host before any call", async () => {
    await open();
    await typeInto(field(document.body, "Hosts, one per line"), "not a host");
    await click(button(document.body, "SAVE"));
    await settle();
    expect(bed.called("projects.setBox")).toEqual([]);
    expect(text(document.body)).toContain("Host names (api.example.com or *.example.com)");
  });

  it("offers START on a stopped box, and RESTART BOX and REBUILD call their methods", async () => {
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    await open("stopped");
    expect(button(document.body, "START")).toBeDefined();
    expect(document.body.textContent).not.toContain("RESTART BOX");
    await click(button(document.body, "REBUILD"));
    expect(bed.called("projects.rebuild")[0]?.params).toEqual({ projectId: "b1" });
  });

  it("restarts a running box", async () => {
    await open();
    await click(button(document.body, "RESTART BOX"));
    expect(bed.called("projects.restartBox")[0]?.params).toEqual({ projectId: "b1" });
  });

  it("shows the packages notice and the chip when the yaml asks for other packages", async () => {
    bed.handlers["projects.box"] = () => ({
      box: boxView({ phase: "running", packages: { built: ["git"], wanted: ["git", "jq"] } }),
    });
    await open();
    // Both lists show before Rebuild, so the owner sees what a rebuild would install.
    const body = text(document.body);
    expect(body).toContain("In the box image");
    expect(body).toContain("Asked by `.pi/project.yaml`");
    expect(body).toContain("git, jq");
    expect(text(document.body)).toContain("PACKAGES CHANGED");
    expect(text(document.body)).toContain(
      "`.pi/project.yaml` asks for other packages than the box image. Rebuild to install them; the new image applies at the next start.",
    );
  });

  it("delete shows the counts and asks for the step-up", async () => {
    bed.handlers["projects.delete"] = () => ({ ok: true });
    await open();
    await click(button(document.body, "DELETE PROJECT"));
    const dialog = dialogs().at(-1) as HTMLElement;
    expect(text(dialog)).toContain(
      "Delete notes? Its box, 3 sessions and 1 triggers go. The disk stays in the trash for 7 days.",
    );
    expect(button(dialog, "Cancel").getAttribute("data-variant")).toBe("secondary");
    const confirm = button(dialog, "DELETE PROJECT");
    expect(confirm.getAttribute("data-variant")).toBe("danger");
    await click(confirm);
    await settle();
    expect(stepUp).toHaveBeenCalledOnce();
    expect(bed.called("projects.delete")[0]?.params).toEqual({ projectId: "b1" });
    expect(bed.called("projects.delete")[0]?.options).toMatchObject({ commandId: "step-cmd-1" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("says a refused delete in words and keeps the dialogs open", async () => {
    bed.handlers["projects.delete"] = () => {
      throw new RpcError("conflict");
    };
    await open();
    await click(button(document.body, "DELETE PROJECT"));
    await click(button(dialogs().at(-1) as HTMLElement, "DELETE PROJECT"));
    await settle();
    const said = text(dialogs().at(-1) as HTMLElement);
    expect(said).toContain(
      "The project was not deleted: it changed while you were asking. Nothing was removed.",
    );
    expect(said).not.toContain("Scratch");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("words a refused delete of Scratch with its own reason", async () => {
    bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "running", scratch: true }) });
    bed.handlers["projects.delete"] = () => {
      throw new RpcError("conflict");
    };
    await open();
    await click(button(document.body, "DELETE PROJECT"));
    await click(button(dialogs().at(-1) as HTMLElement, "DELETE PROJECT"));
    await settle();
    expect(text(dialogs().at(-1) as HTMLElement)).toContain(
      "Scratch was not deleted: it still holds sessions.",
    );
  });

  it("names the project once in one title string, and tells a failed start in three parts, politely", async () => {
    bed.handlers["projects.startBox"] = () => {
      throw new RpcError("capacity");
    };
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    await open("stopped");
    expect(text(document.body)).toContain("Project settings · notes");
    await click(button(document.body, "START"));
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text(document.body)).toContain("Your files are intact.");
  });

  it("says its words in French", async () => {
    const { setLocale } = await import("../../i18n/index.ts");
    setLocale("fr");
    await open();
    expect(text(document.body)).toContain("RESSOURCES");
    await click(button(document.body, "SUPPRIMER LE PROJET"));
    expect(text(dialogs().at(-1) as HTMLElement)).toContain(
      "Supprimer notes ? Sa box, 3 sessions et 1 déclencheurs disparaissent. Le disque reste 7 jours dans la corbeille.",
    );
    setLocale("en");
  });
});

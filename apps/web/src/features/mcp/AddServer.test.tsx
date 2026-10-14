// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { button, click, field, settle, text, typeInto } from "../../testing/dom.ts";
import { CWD, current, newBed, overviewOf, PROJECT_FILE, prompt, show } from "./mcp-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  prompt.answer = true;
  prompt.asked = 0;
  vi.restoreAllMocks();
});

const ASK = `This changes ${PROJECT_FILE}, which can run commands later. Save anyway?`;
const REMOTE = { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer s3cret-token" } };

async function openAdd(overview = overviewOf(), cwd: string | null = CWD) {
  const bed = newBed(overview);
  bed.handlers["mcp.add"] = () => ({ ok: true });
  const page = await show(cwd);
  await settle();
  await click(button(page.container, "Add server"));
  return { bed, page };
}

const listText = (page: { container: HTMLElement }) =>
  [...page.container.querySelectorAll("li")].map((one) => one.textContent).join(" ") ?? "";

async function paste(page: { container: HTMLElement }, content: string) {
  await typeInto(field(page.container, "Paste a config") as HTMLTextAreaElement, content);
  await click(button(page.container, "Read"));
}

describe("paste importer", () => {
  it("shows each candidate masked, and sends nothing until Add", async () => {
    const { bed, page } = await openAdd();
    await paste(page, JSON.stringify({ mcpServers: { api: REMOTE } }));
    expect(text(page.container)).toContain("api");
    expect(text(page.container)).toContain("https://api.example.com/mcp");
    expect(text(page.container)).toContain("Authorization •••");
    expect(listText(page)).not.toContain("s3cret-token");
    expect(bed.called("mcp.add")).toHaveLength(0);
  });

  it("sends the raw entry once, through the step-up for a global target, then reads the list again", async () => {
    const { bed, page } = await openAdd();
    bed.handlers["mcp.add"] = () => Promise.reject(new RpcError("step_up_required"));
    await paste(page, JSON.stringify({ mcpServers: { api: REMOTE } }));
    await click(button(page.container, "Add 1"));
    await settle();
    expect(prompt.asked).toBe(1);
    const sent = bed.called("mcp.add").map((call) => call.params);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ scope: "global", name: "api", entry: REMOTE, cwd: CWD });
    expect(bed.called("mcp.overview")).toHaveLength(2);
  });

  it("adds one call per server and keeps going when one is refused", async () => {
    const { bed, page } = await openAdd();
    bed.handlers["mcp.add"] = (params) => {
      if ((params as { name: string }).name === "b") return Promise.reject(new RpcError("conflict"));
      return { ok: true };
    };
    await paste(page, JSON.stringify({ a: { command: "x" }, b: { command: "y" }, c: { command: "z" } }));
    await click(button(page.container, "Add 3"));
    await settle();
    expect(bed.called("mcp.add").map((call) => (call.params as { name: string }).name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Added 2. b: A server with this name already exists.",
    );
    // Only the refused server stays listed, and the panel stays open (M8).
    expect(button(page.container, "Add 1")).toBeTruthy();
    expect(text(page.container.querySelector('ul[aria-label="Servers to add"]') as HTMLElement)).toContain(
      "b",
    );
    expect(
      text(page.container.querySelector('ul[aria-label="Servers to add"]') as HTMLElement),
    ).not.toContain("a");
    expect(page.container.querySelector("textarea")).not.toBeNull();
  });

  it("stops at a cancelled step-up: nothing after it is sent, and the rest stays listed without an alert", async () => {
    const { bed, page } = await openAdd();
    prompt.answer = false;
    bed.handlers["mcp.add"] = (params) =>
      (params as { name: string }).name === "a"
        ? { ok: true }
        : Promise.reject(new RpcError("step_up_required"));
    await paste(page, JSON.stringify({ a: { command: "x" }, b: { command: "y" }, c: { command: "z" } }));
    await click(button(page.container, "Add 3"));
    await settle();
    expect(bed.called("mcp.add").map((call) => (call.params as { name: string }).name)).toEqual(["a", "b"]);
    expect(prompt.asked).toBe(1);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(button(page.container, "Add 2")).toBeTruthy();
    expect(text(page.container.querySelector('ul[aria-label="Servers to add"]') as HTMLElement)).toBe("bycz");
  });

  it("asks 'Save anyway?' for a project target, sends nothing on Cancel, confirmProtected on Save", async () => {
    const { bed, page } = await openAdd();
    await click(button(page.container, "This project"));
    await paste(page, "npx -y @scope/server");
    await click(button(page.container, "Add 1"));
    expect(text(page.container)).toContain(ASK);
    expect(bed.called("mcp.add")).toHaveLength(0);
    await click(button(page.container, "Cancel"));
    expect(text(page.container)).not.toContain(ASK);
    expect(bed.called("mcp.add")).toHaveLength(0);
    await click(button(page.container, "Add 1"));
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("mcp.add").map((call) => call.params)).toEqual([
      {
        scope: "project",
        name: "server",
        entry: { command: "npx", args: ["-y", "@scope/server"] },
        cwd: CWD,
        confirmProtected: true,
      },
    ]);
    expect(prompt.asked).toBe(0);
  });

  it("says 'Nothing to import' for garbage and shows a note when the paste is cut", async () => {
    const { page } = await openAdd();
    await paste(page, "just some words");
    expect(text(page.container)).toContain("Nothing to import.");
    const servers = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, { command: "x" }]));
    await paste(page, JSON.stringify({ mcpServers: servers }));
    expect(text(page.container)).toContain("Only the first 200 servers are shown.");
    expect(button(page.container, "Add 200")).toBeTruthy();
  });

  it("writes a hidden character of a pasted name as a visible escape", async () => {
    const { page } = await openAdd();
    await paste(page, JSON.stringify({ x: { command: "c\u202Ed", env: { "EV\u202EIL": "v" } } }));
    expect(listText(page)).toContain("EV\\u202EIL •••");
    expect(listText(page)).toContain("c\\u202Ed");
    expect(listText(page)).not.toContain("\u202E");
  });

  it("clears the paste and closes after a successful add, and puts focus back on the opener", async () => {
    const { page } = await openAdd();
    await paste(page, JSON.stringify({ a: { command: "x" } }));
    await click(button(page.container, "Add 1"));
    await settle();
    expect(page.container.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button(page.container, "Add server"));
  });

  it("keeps the paste and shows the fixed text when the add fails", async () => {
    const { bed, page } = await openAdd();
    bed.handlers["mcp.add"] = () => Promise.reject(new RpcError("bad_request"));
    await paste(page, JSON.stringify({ a: { command: "x" } }));
    await click(button(page.container, "Add 1"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button(page.container, "Add 1")).toBeTruthy();
  });

  it("drops a second click while the add is on its way", async () => {
    const { bed, page } = await openAdd();
    let finish: (value: unknown) => void = () => {};
    bed.handlers["mcp.add"] = () => new Promise((resolve) => (finish = resolve));
    await paste(page, JSON.stringify({ a: { command: "x" } }));
    await click(button(page.container, "Add 1"));
    expect(button(page.container, "Add 1").disabled).toBe(true);
    await click(button(page.container, "Add 1"));
    expect(bed.called("mcp.add")).toHaveLength(1);
    finish({ ok: true });
    await settle();
  });
});

describe("importer details (MC48)", () => {
  it("clears the raw text once Read worked, and keeps it when nothing was read", async () => {
    const { page } = await openAdd();
    await paste(page, "nonsense");
    expect((field(page.container, "Paste a config") as HTMLTextAreaElement).value).toBe("nonsense");
    await paste(page, "npx -y srv");
    expect((field(page.container, "Paste a config") as HTMLTextAreaElement).value).toBe("");
    expect(button(page.container, "Add 1")).toBeTruthy();
  });

  it("lists the ignored flags of a claude mcp add line, and sends its -e as env", async () => {
    const { bed, page } = await openAdd();
    await paste(page, "claude mcp add -t stdio x -e K=v -- npx srv");
    expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Ignored: -t");
    await click(button(page.container, "Add 1"));
    await settle();
    expect(bed.called("mcp.add").map((call) => (call.params as { entry: unknown }).entry)).toEqual([
      { command: "npx", args: ["srv"], env: { K: "v" } },
    ]);
  });

  it("announces 'Nothing to import' and the cut note as status, and names the candidate list", async () => {
    const { page } = await openAdd();
    await paste(page, "just words");
    expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Nothing to import.");
    const servers = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`s${i}`, { command: "x" }]));
    await paste(page, JSON.stringify(servers));
    expect(page.container.querySelector('[role="status"]')?.textContent).toBe(
      "Only the first 200 servers are shown.",
    );
    expect(page.container.querySelector('ul[aria-label="Servers to add"]')).not.toBeNull();
  });

  it("disables both save targets while 'Save anyway?' is open", async () => {
    const { page } = await openAdd();
    await click(button(page.container, "This project"));
    await paste(page, "npx srv");
    await click(button(page.container, "Add 1"));
    expect(text(page.container)).toContain(ASK);
    expect(button(page.container, "Global").disabled).toBe(true);
    expect(button(page.container, "This project").disabled).toBe(true);
    await click(button(page.container, "Cancel"));
    expect(button(page.container, "Global").disabled).toBe(false);
  });

  it("moves focus into the panel on open and back to the opener on Close", async () => {
    const { page } = await openAdd();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Add server");
    expect(document.activeElement?.getAttribute("role")).toBe("group");
    await click(button(page.container, "Close"));
    expect(document.activeElement).toBe(button(page.container, "Add server"));
  });
});

describe("form", () => {
  it("builds a stdio entry from its fields", async () => {
    const { bed, page } = await openAdd();
    await typeInto(field(page.container, "Name"), "files");
    await typeInto(field(page.container, "Command"), "npx");
    await typeInto(field(page.container, "Arguments (one per line)"), "-y\n@x/files\n");
    await typeInto(field(page.container, "Environment variables (KEY=value, one per line)"), "TOKEN=a=b");
    await click(button(page.container, "Add"));
    await settle();
    expect(bed.called("mcp.add").map((call) => call.params)).toEqual([
      {
        scope: "global",
        name: "files",
        entry: { command: "npx", args: ["-y", "@x/files"], env: { TOKEN: "a=b" } },
        cwd: CWD,
      },
    ]);
  });

  it("builds an http entry with headers", async () => {
    const { bed, page } = await openAdd();
    await click(button(page.container, "Address"));
    await typeInto(field(page.container, "Name"), "api");
    await typeInto(field(page.container, "Address (http(s)://…)"), "https://api.example.com/mcp");
    await typeInto(field(page.container, "Headers (Name: value, one per line)"), "Authorization: Bearer x");
    await click(button(page.container, "Add"));
    await settle();
    expect(bed.called("mcp.add").map((call) => (call.params as { entry: unknown }).entry)).toEqual([
      { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer x" } },
    ]);
  });

  it("keeps Add off until the name and the command are valid, and says why", async () => {
    const { bed, page } = await openAdd();
    expect(button(page.container, "Add").disabled).toBe(true);
    await typeInto(field(page.container, "Name"), "bad name!");
    await typeInto(field(page.container, "Command"), "npx");
    expect(button(page.container, "Add").disabled).toBe(true);
    expect(text(page.container)).toContain("Letters, digits, _ and -");
    await typeInto(field(page.container, "Name"), "__proto__");
    expect(button(page.container, "Add").disabled).toBe(true);
    expect(bed.called("mcp.add")).toHaveLength(0);
  });

  it("refuses a line without a value", async () => {
    const { page } = await openAdd();
    await typeInto(field(page.container, "Name"), "x");
    await typeInto(field(page.container, "Command"), "npx");
    await typeInto(field(page.container, "Environment variables (KEY=value, one per line)"), "NOEQUALS");
    expect(button(page.container, "Add").disabled).toBe(true);
    expect(text(page.container)).toContain("Each line needs a name and a value");
  });
});

describe("target", () => {
  it("shows the project path and offers the project only when the folder is trusted", async () => {
    const { page } = await openAdd();
    expect(text(page.container)).toContain(PROJECT_FILE);
    expect(button(page.container, "This project").disabled).toBe(false);
  });

  it("has no project target without a folder or in an untrusted project", async () => {
    const none = await openAdd(overviewOf({ project: null }), null);
    expect(button(none.page.container, "This project").disabled).toBe(true);
    expect(text(none.page.container)).toContain("Choose a project in the switcher");
    await none.page.unmount();
    const base = overviewOf();
    const untrusted = await openAdd(
      overviewOf({
        project: { ...(base.project as NonNullable<typeof base.project>), trusted: false, servers: [] },
      }),
    );
    expect(button(untrusted.page.container, "This project").disabled).toBe(true);
  });
});

describe("French", () => {
  it("has no key left over", async () => {
    const { page } = await openAdd();
    setLocale("fr");
    await settle();
    await click(button(page.container, "Adresse"));
    expect(text(page.container)).toContain("Ajouter");
    expect(text(page.container)).not.toMatch(/settingsMcp\./);
  });
});

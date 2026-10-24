import { VmLayout } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { projectLayoutOf } from "./project-layout.ts";

const ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";

describe("projectLayoutOf", () => {
  it("is /boxes/<id> under Kata with the knowledge in the project", () => {
    const layout = projectLayoutOf("kata", "/pap", ID);
    expect(VmLayout.parse(layout)).toEqual(layout);
    expect(layout).toEqual({
      root: `/boxes/${ID}`,
      project: `/boxes/${ID}/project`,
      home: `/boxes/${ID}/home`,
      knowledge: `/boxes/${ID}/project/knowledge`,
      inbox: `/boxes/${ID}/inbox`,
      pi: `/boxes/${ID}/.pi`,
      sessions: `/boxes/${ID}/.pi/sessions`,
      piAgentDir: `/boxes/${ID}/.pi/agent`,
      imageAgentDir: "/opt/pap/pi-agent",
      shellOverlay: "/run/pap-shell",
    });
  });
  it("is $PAP_HOME/tmp/boxes/<id> under the process backend", () => {
    const layout = projectLayoutOf("process", "/pap", ID);
    expect(layout.root).toBe(`/pap/tmp/boxes/${ID}`);
    expect(layout.project).toBe(`/pap/tmp/boxes/${ID}/project`);
    expect(layout.knowledge).toBe(`/pap/tmp/boxes/${ID}/project/knowledge`);
    expect(layout.imageAgentDir).toBe(`/pap/tmp/boxes/${ID}/image-agent`);
    expect(layout.shellOverlay).toBe(`/pap/tmp/boxes/${ID}/run/pap-shell`);
  });
});

// A local MCP server for tests: newline-delimited JSON-RPC 2.0 over stdio, no socket (M5R25).
// argv[2] is JSON: { tools: [{ name, annotations?, reply }], resources?: [{ uri, name, text }] }.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const config = JSON.parse(process.argv[2] ?? "{}");
const tools = config.tools ?? [];
const resources = config.resources ?? [];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (value) => ({ content: [{ type: "text", text: value }] });

const handlers = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {}, ...(resources.length > 0 ? { resources: {} } : {}) },
    serverInfo: { name: "pap-mcp-fixture", version: "0.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: `fixture tool ${tool.name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }),
  "tools/call": (params) => {
    if (config.callsOut) appendFileSync(config.callsOut, `${JSON.stringify(params ?? null)}\n`);
    const tool = tools.find((candidate) => candidate.name === params?.name);
    return tool ? text(tool.reply) : { ...text("unknown tool"), isError: true };
  },
  "resources/list": () => ({
    resources: resources.map(({ uri, name }) => ({ uri, name, mimeType: "text/plain" })),
  }),
  "resources/templates/list": () => ({ resourceTemplates: [] }),
  "resources/read": (params) => ({
    contents: resources
      .filter((resource) => resource.uri === params?.uri)
      .map(({ uri, text: body }) => ({ uri, mimeType: "text/plain", text: body })),
  }),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  // A notification has no id and gets no answer (`notifications/initialized` included).
  if (request.id === undefined) return;
  const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : undefined;
  if (handler) send({ id: request.id, result: handler(request.params) });
  else send({ id: request.id, error: { code: -32601, message: "method not found" } });
});

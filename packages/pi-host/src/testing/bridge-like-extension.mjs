// A stand-in for the registration of pi-claude-bridge (its src/index.ts, "Registration policy across module
// instances"): the first instance of the extension in a process registers the provider at load; a later one only
// registers at `session_start`, and only when the session's registry lacks the provider. A helper's load never fires
// `session_start`, so a process that loaded it once lists no such provider the second time. The stream answers one
// fixed text and reaches no network. Tests copy this file into a temporary agent folder as `extensions/<name>.js`.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER = "pap-test-bridge";
const REPLY = "BRIDGE-REPLY-7c41";
const REGISTERED = Symbol.for("pap-test-bridge:registered");

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function reply(model) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: REPLY }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: REPLY, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: REPLY, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

const config = {
  name: "Test bridge",
  baseUrl: PROVIDER,
  apiKey: "not-used",
  api: PROVIDER,
  models: [
    {
      id: "bridge-one",
      name: "Bridge One",
      reasoning: false,
      input: ["text"],
      cost: zero,
      contextWindow: 200000,
      maxTokens: 1000,
    },
  ],
  streamSimple: reply,
};

export default function (pi) {
  if (!globalThis[REGISTERED]) {
    globalThis[REGISTERED] = true;
    pi.registerProvider(PROVIDER, config);
    return;
  }
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.modelRegistry.getProvider(PROVIDER)) pi.registerProvider(PROVIDER, config);
  });
}

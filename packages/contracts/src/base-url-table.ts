import type { BaseUrlRefusal } from "./base-url.ts";

export type Verdict = "ok" | BaseUrlRefusal;
const bidi = String.fromCodePoint(0x202e);
const zwsp = String.fromCodePoint(0x200b);
/**
 * THE one table of the base URL policy (owner q4, MPR9): url, verdict under "loopback", verdict under "any". The
 * contracts tests and the provider form's tests read it, so a flip of `HTTP_PLAINTEXT_POLICY` changes no test.
 */
export const BASE_URL_TABLE: ReadonlyArray<readonly [string, Verdict, Verdict]> = [
  ["https://api.example.com/v1", "ok", "ok"],
  ["https://api.example.com/v1/", "ok", "ok"],
  ["https://192.168.1.5:8443/v1", "ok", "ok"],
  ["http://localhost:11434/v1", "ok", "ok"],
  ["http://127.0.0.1:8000", "ok", "ok"],
  ["http://[::1]:8080/v1", "ok", "ok"],
  ["http://127.1.2.3", "ok", "ok"],
  ["http://0x7f.1/", "ok", "ok"],
  ["http://2130706433/", "ok", "ok"],
  ["http://192.168.1.50:11434/v1", "host", "ok"],
  ["http://gpu:11434/v1", "host", "ok"],
  ["http://ollama.local:11434/v1", "host", "ok"],
  ["http://example.com", "host", "ok"],
  ["http://169.254.169.254/latest", "host", "ok"],
  ["http://localhost.evil.com", "host", "ok"],
  ["http://127.0.0.1.evil.com", "host", "ok"],
  ["http://[::ffff:127.0.0.1]", "host", "ok"],
  ["http://0.0.0.0:11434", "host", "ok"],
  ["ftp://x", "scheme", "scheme"],
  ["file:///etc/passwd", "scheme", "scheme"],
  ["https://user:pw@api.example.com", "credentials", "credentials"],
  ["http://user@192.168.1.5", "credentials", "credentials"],
  ["https://api.example.com/v1?key=1", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/#x", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/?", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/a b", "control", "control"],
  ["https://api.example.com/\t", "control", "control"],
  [`https://api.example.com/${bidi}`, "control", "control"],
  [`https://api.example.com/${zwsp}`, "control", "control"],
  [`https://${"a".repeat(2050)}.com`, "too_long", "too_long"],
  ["not a url", "control", "control"],
  ["nope", "not_a_url", "not_a_url"],
];

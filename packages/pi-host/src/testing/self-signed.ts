import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** A throwaway self-signed certificate for 127.0.0.1 and its key as PEM files in `dir`: tests only, the one CA a test trusts. */
export function loopbackCertificate(dir: string): { cert: string; key: string } {
  const files = { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
    ].concat([
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      files.key,
      "-out",
      files.cert,
    ]),
    { stdio: "ignore" },
  );
  return files;
}

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** A throwaway self-signed certificate and its key as PEM files in `dir`: for tests only. */
export function selfSignedCertificate(dir: string): { cert: string; key: string } {
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
    ].concat(["-subj", "/CN=localhost", "-keyout", files.key, "-out", files.cert]),
    { stdio: "ignore" },
  );
  return files;
}

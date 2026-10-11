export function workerEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !key.startsWith("PAP_")) env[key] = value;
  return { ...env, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...extra };
}

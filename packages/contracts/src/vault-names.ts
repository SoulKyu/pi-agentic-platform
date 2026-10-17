/** An environment name a sandboxed shell receives: upper case, digits, underscore. */
export const VAULT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * Names that would change how the shell, bwrap or a tool runs, not what it reads: refused (W5-R17). The vault reaches the
 * environment of the unsandboxed, non-setuid bwrap itself, so glibc's unsecure-environment names are in the list.
 */
const HIJACK_EXACT: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "IFS",
  "PS4",
  "PWD",
  "OLDPWD",
  "PROMPT_COMMAND",
  "SSH_AUTH_SOCK",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONWARNINGS",
  "PYTHONINSPECT",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "GLIBC_TUNABLES",
  "GCONV_PATH",
  "SHELLOPTS",
  "BASHOPTS",
  "XDG_CONFIG_HOME",
  "LESSOPEN",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "LANG",
  "TERM",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "RESOLV_HOST_CONF",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "MALLOC_TRACE",
  "TZDIR",
  "GETCONF_DIR",
  "NIS_PATH",
]);
const HIJACK_PREFIX: readonly string[] = [
  "PI_",
  "PAP_",
  "NODE_",
  "LD_",
  "DYLD_",
  "GIT_",
  "BASH_FUNC_",
  "LC_",
  "NPM_CONFIG_",
];

export const isVaultName = (name: string): boolean =>
  VAULT_NAME.test(name) &&
  !HIJACK_EXACT.has(name) &&
  !HIJACK_PREFIX.some((prefix) => name.startsWith(prefix)) &&
  !name.endsWith("_PROXY");

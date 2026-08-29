const PROFILE_ENVIRONMENT_ALLOWLIST = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'DSH_TELEMETRY_DISABLED',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
])

/**
 * Build the inherited environment for one profile-owned DSH process.
 *
 * Provider tokens, API keys, OAuth variables, Node injection flags, and other
 * ambient application configuration are omitted by default. DSH may still use
 * operating-system identity reachable through HOME or platform keychains; that
 * boundary is system-wide rather than owned by a Workbench profile.
 */
export function buildProfileEnvironment(
  environment: NodeJS.ProcessEnv,
  dshHome: string,
  platformDataRoot: string,
): NodeJS.ProcessEnv {
  const inherited = Object.entries(environment).filter(([key, value]) => (
    value !== undefined && (
      PROFILE_ENVIRONMENT_ALLOWLIST.has(key.toUpperCase())
      || key.toUpperCase().startsWith('LC_')
    )
  ))

  return {
    ...Object.fromEntries(inherited),
    DSH_HOME: dshHome,
    DSH_WORKBENCH_PLATFORM_DATA_DIR: platformDataRoot,
  }
}

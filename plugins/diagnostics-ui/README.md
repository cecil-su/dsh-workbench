# `@dsh-workbench/diagnostics-ui`

This first-party plugin adds a **Workbench diagnostics** tab beside the pinned
DSH release's official Plugin configuration and Plugin list tabs.

The official `pluginInventory/list` Remote remains the only source of Loader
state. Workbench projects only its fixed DSH version and first-party overlay
entries into compatibility checks; every other plugin remains unassessed and
visible in the official Plugin list.

The Electron bridge supplies only the current profile generation's bounded,
sanitized in-memory runtime log and three fixed actions: restart the active DSH
runtime, repair Workbench-owned overlay links and restart, or clear that
generation's log. Restart and repair require a native confirmation and run in
the same serialized lifecycle coordinator as profile selection, recovery, and
shutdown. No path, command, module specifier, plugin id, arbitrary configuration,
raw credential, or raw IPC channel crosses the bridge.

Installed client plugins share the DSH page's renderer trust domain. This UI is
not a sandbox for untrusted browser plugins and does not install, enable,
disable, update, or remove third-party plugins.

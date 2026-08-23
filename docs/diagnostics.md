# Diagnostics and repair

## Ownership and scope

Workbench diagnostics is a first-party view inside `Settings > Plugins`. It
combines two authoritative sources without creating a second plugin manager:

- DSH's official `pluginInventory.list()` Remote is the sole source for Loader
  entry, enabled, and Fiber phase state;
- the Electron host owns the active DSH process generation and a bounded,
  in-memory runtime log.

The compatibility projection is deliberately fixed to the pinned DSH release
and Workbench's four required overlay entries. Other plugins remain visible in
the official Plugin list, but Workbench neither judges nor mutates them. This
milestone does not add install, enable, disable, remove, or arbitrary plugin
configuration operations.

## Log boundary

DSH stdout and stderr pass through a streaming sanitizer before they can reach
the console, error tail, diagnostics ring, renderer, or package-smoke evidence.
The sanitizer removes terminal control and bidirectional override sequences and
redacts authorization headers, credential-like fields, sensitive URL query
values, and common token prefixes. It also handles split UTF-8 chunks and split
secret lines and discards an overlong unterminated line.

The host keeps at most 256 entries and 64 KiB in memory. Every entry belongs to
one profile ID and one runtime generation; reads and clears require the active
profile context supplied by the frozen preload bridge. Logs are not persisted,
and diagnostics snapshots contain versions, profile identity, generation,
runtime state, and cursors only. Startup failure dialogs can copy the same
bounded, redacted diagnostic text to the clipboard.

Sanitization is defense in depth, not a guarantee that arbitrary third-party
output can never contain an unknown secret format. Providers and plugins should
still avoid writing credentials to stdout or stderr.

## Repair boundary

The preload exposes only three named actions:

1. `clear-runtime-logs` removes entries for the active profile generation;
2. `restart-active-runtime` stops and replaces the active DSH process and its
   BrowserWindow after native confirmation;
3. `repair-first-party-overlay` recreates only the Workbench-owned patch and
   package links, then performs the same confirmed restart.

Requests use a closed schema, an opaque request ID, the active main frame and
loopback origin, and the exact profile generation. Restart and overlay repair
are serialized with profile selection and shutdown by the main-process
transition coordinator. The generation is checked again after native
confirmation and immediately before mutation. A failed replacement window
causes the newly restarted runtime to be stopped rather than left orphaned.

No action accepts a path, command, module name, or third-party plugin ID. Repair
does not edit DSH Core, user plugins, credentials, profile data, or the official
inventory.

## Acceptance

Automated gates cover streaming redaction, control-sequence removal, bounded
memory, pagination, closed IPC schemas, origin and generation fencing, and
restart serialization. The real DSH integration verifies that the diagnostics
client bundle reaches the Web boot payload.

The packaged smoke test runs from a copied installation and verifies the real
official inventory Remote and four required active entries. A temporary smoke
plugin loaded by the packaged DSH child writes a fresh random canary across
separate stdout and stderr chunks. The benign markers must survive through the
console, diagnostic ring, IPC bridge, DOM, application report, and harness
report, while the canary is absent from every one of those surfaces.

Smoke mode then removes the OAuth UI entry from the Workbench overlay while
leaving Diagnostics UI loadable. Acceptance requires an attention state, the
missing-entry diagnosis, and the real `repair-first-party-overlay` button. The
button must restore all entries to healthy state and turn over the DSH PID,
loopback port, and BrowserWindow, with the stale process, port, and window gone.

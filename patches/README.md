# Upstream patches

Patches are exceptions, not an extension system. Prefer a Cordis/DSH plugin or
an upstream pull request.

Every patch added here must document:

- package and exact affected version;
- reason an existing extension point is insufficient;
- upstream issue and pull request, when available;
- owner and date introduced;
- test that protects the behavior;
- objective condition for deleting the patch.

## `@deepseek-ai/dsh-host-directory-picker-native@0.1.1-rc.2`

- Patch: `@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch`
- Reason: the Win32 dialog worker disconnects its IPC channel after the
  non-terminal `showing` notice, so the selected-path `done` message can be
  lost. After retaining IPC, its selected-path decoder calls `koffi.view()`,
  which Electron forbids because it creates an external buffer; the resulting
  native crash also exits the worker without a result. The public
  directory-picker extension point can replace the whole backend, but it cannot
  replace only this private worker lifecycle and COM-memory decoder without
  duplicating the upstream COM implementation and changing native behavior.
- Tracking: Workbench issues
  [#8](https://github.com/cecil-su/dsh-workbench/issues/8) and
  [#10](https://github.com/cecil-su/dsh-workbench/issues/10). No upstream issue
  or pull request was available when this patch was introduced.
- Owner: DSH Workbench maintainers (`cecil-su`).
- Introduced: 2026-08-23.
- Protection: `scripts/directory-picker-patch.test.mjs` exercises the installed
  helper's `showing`, `done`, `error`, and already-disconnected paths and locks
  the Electron-safe UTF-16 decoder plus COM-memory cleanup;
  `scripts/verify-compatibility.test.mjs` locks the patch declaration and
  provenance; `scripts/package.mjs` requires the patched worker and helper in
  both the production stage and final packaged application.
- Removal condition: delete this patch after the pinned DSH release contains
  equivalent IPC and Electron-safe COM string decoding fixes, and Windows
  package verification passes real select, cancel, and abort flows without the
  patch.

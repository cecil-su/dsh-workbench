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

## `@deepseek-ai/dsh-sandbox-windows-acl@0.1.1-rc.2`

- Patch: `@deepseek-ai__dsh-sandbox-windows-acl@0.1.1-rc.2.patch`
- Reason: confined Windows tool calls are launched by the ACL runner through
  `CreateProcessAsUserW`, beyond the already-hidden subprocess wrapper. Its
  `STARTUPINFOW` requests redirected standard handles but not
  `STARTF_USESHOWWINDOW`/`SW_HIDE`, so a child such as `pwsh.exe` can still
  display a console window. `CREATE_NO_WINDOW` is not usable because the
  upstream restriction scheme documents that it makes restricted children
  fail during DLL initialization. The sandbox extension point can replace the
  whole provider, but it cannot change this private restricted-token spawn
  without duplicating token construction, ACL grants, and job supervision.
- Tracking: Workbench issue
  [#11](https://github.com/cecil-su/dsh-workbench/issues/11). No upstream issue
  or pull request was available when this patch was introduced.
- Owner: DSH Workbench maintainers (`cecil-su`).
- Introduced: 2026-08-24.
- Protection: `scripts/subprocess-windows-hide-patch.test.mjs` locks the exact
  installed package version and both restricted-token startup records;
  `scripts/verify-compatibility.test.mjs` locks the patch declaration and
  provenance; `scripts/package.mjs` requires the patched implementation in the
  production stage and final packaged application.
- Removal condition: delete this patch after the pinned DSH release applies an
  equivalent non-isolating hidden-window startup hint to restricted Windows
  children and a packaged confined PowerShell subagent call completes without
  a visible console window.

## `@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2`

- Patch: `@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch`
- Reason: the direct subprocess implementation does not set Node's
  `windowsHide` spawn option, and its `taskkill` helpers are also spawned
  without that option. When the Windows model tool starts or stops `pwsh.exe`
  from the GUI-hosted DSH runtime, a tool call can therefore create a visible
  console window. The subprocess service extension point can replace the whole
  provider, but it cannot change these spawn options without duplicating the
  upstream process supervision, output collection, and termination
  implementation.
- Tracking: Workbench issue
  [#11](https://github.com/cecil-su/dsh-workbench/issues/11). No upstream issue
  or pull request was available when this patch was introduced.
- Owner: DSH Workbench maintainers (`cecil-su`).
- Introduced: 2026-08-23.
- Protection: `scripts/subprocess-windows-hide-patch.test.mjs` locks the exact
  installed package version, Win32-only direct spawn option, and hidden
  `taskkill` helpers;
  `scripts/verify-compatibility.test.mjs` locks the patch declaration and
  provenance; `scripts/package.mjs` requires the patched implementation in the
  production stage and final packaged application.
- Removal condition: delete this patch after the pinned DSH release hides
  direct Windows subprocess and termination-helper console windows equivalently
  and a packaged Windows model PowerShell tool call completes without a visible
  console window.

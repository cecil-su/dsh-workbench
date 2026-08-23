# Packaging and release acceptance

DSH Workbench packages a production deployment of the Electron host, the exact
DSH runtime, and first-party plugins for the current operating system and CPU
architecture. Packaging always runs on the target platform so native and
optional dependencies match the machine that will execute them.

## Local commands

```sh
pnpm package:dir
pnpm test:package
pnpm package:artifacts
```

`package:dir` creates an unpacked application under `dist/artifacts` for fast
acceptance testing. `test:package` copies that complete application outside the
checkout, assigns isolated user-data and working directories, and then starts
the copied executable. After `package:artifacts`, the same command extracts the
generated ZIP outside the checkout and starts that distribution instead.
`package:artifacts` creates the platform distribution formats and a
`SHA256SUMS` file. Artifact packaging requires a clean Git worktree. Its package
manifest records the exact revision, lockfile identity, compatibility identity,
tool versions, platform, architecture, and complete artifact list.

For an offline or unreliable-network rebuild, set the task-specific
`DSH_WORKBENCH_ELECTRON_DIST` environment variable to an unpacked Electron
distribution, its release ZIP, or a directory containing the correctly named
release ZIP. Electron Builder validates that distribution before packaging.

Linux package smoke runs under the current display. In a headless environment,
install `xvfb-run`; the smoke runner selects it automatically when `DISPLAY` is
unset.

## Self-contained production deployment

The package script uses `pnpm deploy` with injected workspace packages and a
hoisted production dependency layout. The production `node_modules` tree is
copied verbatim after Electron's dependency scan so transitive and
platform-specific optional packages cannot be dropped by hoisted-tree
deduplication. Build-only pnpm state is removed, first-party production
manifests are pinned to their installed versions, and the package is scanned
for source-checkout references. The script also rejects any deployment or
packaged symlink whose resolved target escapes its own tree. This prevents a
build from passing only because the original checkout or pnpm store is still
present.

ASAR is deliberately disabled. DSH starts as a real child-process entry file,
and its profile loader may create filesystem links to the packaged dependency
closure. Those operations require ordinary files inside `resources/app`.
Because DSH is launched with the packaged Electron executable in Node mode, the
`runAsNode` fuse remains enabled. Node option and inspector injection, elevated
`file:` privileges, and ASAR-only loading are disabled explicitly.
The supervised DSH child receives Node's explicit `--expose-internals` flag
because the pinned Cordis HMR service uses the internal ESM loader; Electron's
embedded Node cannot use DSH's native fallback for that lookup.
After fuse mutation, macOS CI builds restore the executable's ad-hoc signature
so Apple Silicon can launch it; this is not a trusted developer signature.

## Acceptance checks

The packaged application has a private smoke mode used only when both absolute
smoke arguments are present. A passing report proves that:

- Electron reports `app.isPackaged` and resolves DSH plus `desktop-core` inside
  the copied package resources;
- the real DSH Web host sends its ready message and serves the expected boot
  payload from a loopback URL;
- the packaged native PTY helper runs a real command, returns its output, and
  leaves no live PID;
- a hidden BrowserWindow loads that URL with context isolation, sandboxing,
  Web security, and Node integration restrictions verified in the renderer;
- the official plugin inventory reports every fixed Workbench entry active,
  a random canary emitted across separate stdout/stderr writes by a temporary
  DSH smoke plugin reaches the console, diagnostic ring, IPC bridge, and DOM
  only in redacted form while benign markers survive into both smoke reports;
- smoke mode removes one first-party overlay entry while retaining Diagnostics
  UI, observes the resulting attention state and repair button, then exercises
  that button and proves healthy recovery with DSH PID/port and BrowserWindow
  turnover;
- DSH exits through graceful IPC with code zero; and
- the supervised PID and TCP port are gone after shutdown.

The report contains paths and lifecycle evidence, but it never uploads the
temporary DSH profile or user-data directory.

## CI artifacts and signing boundary

Pull requests and `main` builds run unpacked package smoke on fixed Linux x64,
macOS arm64, and Windows x64 runners. Tags beginning with `v`, and manual runs
of the release workflow, create these unsigned CI artifacts:

- macOS: DMG and ZIP;
- Windows: NSIS installer and ZIP;
- Linux: AppImage, `tar.gz`, and ZIP.

Artifact names include `unsigned-ci`. These files are engineering acceptance
outputs, not end-user releases. Code signing, macOS notarization, trusted
publisher credentials, update metadata, and publication remain separate future
release gates; no signing secret is stored in this repository.

After all three native jobs pass, the release workflow verifies the complete
artifact, checksum, application-smoke, and harness-smoke evidence matrix and
uploads `release-qualification.json`. See
[Release qualification](release-qualification.md) for the compatibility lock,
provenance fields, smoke-to-manifest binding, exact platform set, and aggregate
acceptance rules.

The Linux job uses Ubuntu 22.04 so the produced distribution keeps an older
glibc baseline and Chromium developer builds can use unprivileged user
namespaces without changing the runner's AppArmor policy. The job proves that
user namespaces are available, then launches the extracted release ZIP with
Chromium's setuid fallback disabled. Chromium therefore uses its modern
user-namespace and seccomp sandbox without granting root ownership or a setuid
bit to any artifact. The harness verifies that the extracted helper is
unprivileged and byte-identical to the packaged helper, and the application
smoke requires the preload process to report `process.sandboxed === true`. The
aggregate qualification report retains that evidence. The release workflow
must not use `--no-sandbox`.

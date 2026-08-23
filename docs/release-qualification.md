# Release qualification

An unsigned DSH Workbench release candidate is qualified only when the same
clean source revision passes the complete native build and smoke suite on Linux
x64, macOS arm64, and Windows x64.

## Compatibility lock

`upstream/compatibility.json` is the machine-readable compatibility contract for
the pinned release. `pnpm verify:compatibility` checks that its DSH and Electron
versions agree with the upstream release record, workspace catalog, every
first-party package manifest, lockfile, diagnostics client, desktop overlay,
packager configuration, and package acceptance checks.

The compatibility identity is the SHA-256 digest of the canonical JSON value:
object keys are sorted recursively, arrays retain their declared order, and the
serialized value contains no insignificant whitespace. A semantic change to the
contract therefore produces a new identity on every platform.

## Per-platform evidence

`pnpm package:artifacts` accepts only a clean Git worktree. Its schema-versioned
package manifest records the exact Git revision, clean-worktree assertion,
lockfile SHA-256, compatibility SHA-256, tool versions, platform, architecture,
and complete artifact list. Every listed distribution file is covered by
`SHA256SUMS`. The lockfile identity covers its raw bytes, while repository
attributes require an LF checkout on every supported platform.

The copied-package smoke produces two reports: the application report proves
the packaged DSH, first-party plugins, profiles, authorization, diagnostics,
repair, renderer security, and shutdown behavior; the harness report proves the
outer process completed without a timeout or credential-canary disclosure and
binds that smoke run to the exact package manifest SHA-256.

## Matrix qualification

The release workflow downloads each platform's upload set and smoke reports,
then runs the release-matrix verifier. Qualification requires exactly these
targets:

- `linux-x64`: AppImage, `tar.gz`, and ZIP;
- `macos-arm64`: DMG and ZIP;
- `windows-x64`: NSIS executable and ZIP.

The verifier checks every file hash and requires all three targets to report the
same Git revision, Workbench version, DSH version, Electron version,
electron-builder version, lockfile identity, and compatibility identity. It
writes one deterministic `release-qualification.json` report for the candidate.

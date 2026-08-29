# Workbench profiles

Workbench profiles are the desktop ownership boundary around one DSH runtime.
Each active profile supplies three independent resources:

- a private `DSH_HOME` for DSH settings, credential documents, and extensions;
- a profile workspace used as the DSH process working directory and capable of
  containing multiple Projects;
- a persistent Electron session partition for cookies and browser storage.

The profile registry is stored under Electron `userData` rather than inside an
existing Harness home:

```text
userData/
  workbench/
    profiles.json
    profiles.json.bak
  profiles/<profile-id>/
    dsh/
    workspace/
  profile-archives/<profile-id>/
    dsh/
    workspace/
```

The registry and directories are private to the current OS user. Registry
publishes use a temporary file, file and directory synchronization, and atomic
rename. Archive and restore publish a recoverable backup before moving the
profile directory. A corrupt primary registry is recovered only from a valid,
self-consistent backup; unknown future schemas and unsafe symbolic-link paths
fail closed.

## Lifecycle

The Profiles section in DSH Settings can create, rename, select, archive, and
restore profiles. Selecting a profile serializes the complete transition:

1. stop and join the current DSH process tree;
2. start DSH with the target `DSH_HOME` and workspace;
3. commit the active profile only after DSH is ready;
4. load a BrowserWindow with the target persistent partition;
5. replace the old window only after the new window loads.

If startup, commit, or window loading fails, Workbench attempts to restore both
the previous runtime and its window. An active profile cannot be archived.
Archiving moves its complete directory to `profile-archives`; it does not delete
profile data.

Existing installations migrate the former `userData/dsh` and
`userData/workspace` directories into the `default` profile. The default
profile also keeps the historical `persist:dsh-workbench` Electron partition,
so browser state survives the upgrade.

## Credential boundary

Workbench passes an allowlisted OS environment to each DSH process, sets the
profile-owned `DSH_HOME`, and points every profile runtime at the same
application-level task platform under `userData/task-platform`. Platform records
never live inside a Profile or a managed repository. Ambient API keys, provider
tokens, Node injection flags, and unrelated application variables are not
inherited. DSH's official
credential provider continues to own `.credentials.yaml`, `.env`, and future
authorization records inside that home.

Operating-system identity reachable through `HOME` or a platform keychain is a
system boundary. Workbench does not copy, serialize, or expose credential
values through the profile registry, renderer bridge, logs, or package smoke
reports.

## Acceptance evidence

The packaged smoke test runs from a copied installation and verifies:

- legacy `userData/dsh` and `userData/workspace` content migrates into Default
  without moving Project files;
- the historical `persist:dsh-workbench` partition remains assigned to Default;
- the real Profiles settings component creates, renames, archives, restores,
  lists, and selects test profiles through the preload and main-process IPC;
- renderer UI actions perform an A → B → A switch;
- each real DSH process reports the expected `DSH_HOME`, workspace, and a
  value-free fingerprint from the official credential service;
- an ambient credential probe is absent inside every DSH process;
- old DSH root processes and loopback ports close before the next profile runs;
- a non-default active profile survives application restart;
- browser cookies remain isolated and persist across both switching and restart;
- preload sandboxing and Electron's renderer security baseline remain enabled.

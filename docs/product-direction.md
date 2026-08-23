# Product direction

## Purpose

DSH Workbench is a general-purpose desktop companion for DeepSeek Harness. It
turns the pinned DSH Web experience into a secure, observable, and distributable
desktop application while keeping upstream Harness replaceable.

It provides a stable desktop foundation for DSH runtime operations, profiles,
official authorization, and plugin extensions.

## Who it serves

DSH Workbench is intended for people who want to:

- run DSH through a native desktop application instead of managing a terminal
  process and browser tab;
- keep local profiles, sessions, credentials, and extensions under explicit
  desktop lifecycle controls;
- use first-party and optional Cordis/DSH plugins without modifying DSH Core;
- diagnose startup, compatibility, authorization, and plugin-loading failures
  from one place.

## Long-term product pillars

### Reliable desktop host

The application owns DSH process startup, readiness, restart, shutdown, port
selection, logs, and failure recovery. It exposes actionable errors and ensures
that supervised processes are cleaned up.

### Distributable application

macOS, Windows, and Linux packages include every runtime and first-party plugin
asset needed after installation. Packaged behavior is verified on a clean
machine as part of release acceptance.

### Profiles and official authorization

Users should be able to create, select, inspect, and recover isolated DSH
profiles. Authorization UI delegates OAuth flows and credential persistence to
public services provided by the pinned DSH release.

### Plugin-first extension experience

Product behavior belongs in Cordis/DSH plugins whenever an extension point
exists. The desktop host should eventually make compatible plugins discoverable,
configurable, diagnosable, and reversible while preserving Electron security.

### Native operations

Once the runtime and packaging foundation is dependable, the application may
add single-instance handling, native menus, tray behavior, update delivery, and
crash diagnostics. Native features remain host concerns, while DSH agent and
provider logic stays within DSH.

## Product and architecture principles

1. Keep the core general-purpose and add product capabilities through plugins
   with explicit scope.
2. Prefer public DSH/Cordis contracts over upstream source changes.
3. Keep the pinned upstream release replaceable and upgrade it in isolated
   compatibility changes.
4. Preserve Electron's sandbox and least-privilege renderer boundary.
5. Keep user data local and recoverable by default. Store Workbench-owned state
   separately from existing DSH user profiles.
6. Treat startup, shutdown, packaging, migration, and recovery behavior as
   testable product functionality.
7. Expose failures with useful logs and explicit recovery actions.

## Roadmap horizons

### Foundation — current

- supervise the exact DSH executable;
- wait for the loopback Web endpoint and load it in a sandboxed window;
- activate first-party plugins through a Workbench-owned profile overlay;
- shut down DSH with the desktop application.

### Near term

- make ports, startup state, retry, logs, crashes, and shutdown robust;
- add real-process integration tests for the host and plugin overlay;
- package the application and verify DSH/plugin loading outside development;
- establish release artifacts and clean-install smoke checks.

### Medium term

- add isolated profile selection and recovery;
- implement official DSH authorization controls in `oauth-ui`;
- add plugin status, compatibility diagnostics, and safe configuration;
- provide user-facing runtime logs and repair actions.

### Later

- ship verified packages across supported desktop platforms;
- add signing, update delivery, single-instance behavior, menus, and tray support;
- improve crash reporting and upstream compatibility automation;
- expand optional plugins without moving their business logic into the host.

The roadmap is ordered by dependency and risk. Runtime reliability is the entry
condition for packaging, authorization, and plugin-management work.

## Success criteria

The long-term direction is succeeding when:

- a clean installation manages DSH startup, restart, and shutdown and cleans all
  supervised processes;
- first-party plugins load deterministically in development and packaged builds;
- profiles and credentials remain isolated, recoverable, and handled by their
  documented owners;
- upstream upgrades use reviewable, isolated compatibility migrations;
- security checks, integration tests, and package smoke tests catch regressions
  before release;
- new contributors can distinguish host responsibilities, DSH responsibilities,
  and optional plugin responsibilities from repository documentation alone.

## Maintaining this document

Update this document when the product's audience, core scope, product pillars,
or roadmap horizons change. Keep implementation details and individual task
lists in architecture notes or issues.

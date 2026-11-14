# Changelog

## 1.0.2

- The forced helper no longer installs a staged `app.asar.new` over the
  application while it is stopped. That step (present in 1.0.1) could put an old
  patched package on top of a freshly updated app, and the next start then died
  with `ENOENT` inside `app.asar.unpacked`. Restarting must never modify the
  installation; the tray tooling installs its own package with a version check.
- `/restart` now compares the `app.asar` manifest version with the executable's
  file version before doing anything and refuses with HTTP 409 /
  `version-mismatch` when they differ, so a broken install is reported instead
  of booted. Best effort: an unreadable or non-version value allows the restart.
  `DSH_SIDEBAR_ACTIONS_SKIP_VERSION_CHECK=1` turns the check off.
- `/diagnose` reports the comparison as `installVersions`.

## 1.0.1

- `clientMounted` in `/api/diagnose` no longer misses the desktop page: fetches
  from `dsh-app://` carry no `Sec-Fetch-Site`, so a browser-ish user agent counts
  too (local probes are still ignored).

## 1.0.0

- First public release.
- Sidebar footer actions: reload, restart, quit.
- Graceful path through an optional desktop shell bridge (request files).
- Forced path on unpatched Windows desktops: per-user scheduled helper task,
  stops only the shell process, waits for the remaining processes, then starts
  the executable again with its original command line.
- Two-click confirmation for restart and quit; the mode is detected and shown.
- `GET /state` exposes mode, task readiness, PIDs, and the log tail.

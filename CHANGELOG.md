# Changelog

## 1.0.4

- Fix the bridge upkeep inside the desktop host: Electron's patched `fs` treats
  a path ending in `.asar` as the archive root (`stat` reports size 0, `open`
  throws `ENOENT, not found in <archive>`), so the freshness check and the
  rebuild failed silently in 1.0.3. Both now use `original-fs`, which bypasses
  that layer; the plain-Node fallback is unchanged.

## 1.0.3

- The graceful bridge now survives app updates by itself. Every DSH update
  replaces `app.asar`, which drops the request pollers; the plugin rebuilds the
  patched copy for the installed version shortly after startup and the helper
  installs it during the next restart. Version, sizes and hash are re-checked at
  install time, the replaced package is kept as a backup, and a patched package
  that does not start is reverted automatically.
- A bridge marker older than the installed package is treated as dead: the
  click goes straight to the helper instead of waiting 2.5 s for a request
  nobody consumes, and the marker is dropped after the first miss.
- `DSH_SIDEBAR_ACTIONS_AUTO_PATCH=0` turns the rebuild off; `/state` and
  `/diagnose` report `bridgeFresh` and the staged patch.

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

# Changelog

## 1.0.0

- First public release.
- Sidebar footer actions: reload, restart, quit.
- Graceful path through an optional desktop shell bridge (request files).
- Forced path on unpatched Windows desktops: per-user scheduled helper task,
  stops only the shell process, waits for the remaining processes, then starts
  the executable again with its original command line.
- Two-click confirmation for restart and quit; the mode is detected and shown.
- `GET /state` exposes mode, task readiness, PIDs, and the log tail.

# Changelog

## 0.3.0-beta.2 — 2026-10-27
- Align `reposuite-gateway` embedded Cloud `GatewayHello` / `GatewayHelloResult` wire JSON field (`gateway`) with deployed RepoSuite Control (`4a828d2`)
- Add raw-wire regression test covering first invite claim, `0600` credential persistence, authenticated resume, and `epoch_mismatch` resync
- Fix `http_tcp` Host header (`127.0.0.1:<port>`) — Relay's strict Host validation returned HTTP 421 to the portless Host, causing the ~30s first-setup health timeout observed on WORK
- Fix first-install rollback: with no previous version, `setup`/`update apply`/`rollback` failures now stop+disable the new units, remove files and activation, and reap orphaned daemons instead of restarting deleted units
- Reap partial-install orphan daemons (scoped to executables under `versions/`/`current/bin`, systemd-active services excluded) before restart
- `health_wait` now reports which leg timed out for diagnosis

## 0.3.0-beta.1 — 2026-10-27
- npm-first distribution: `reposuite` CLI + `@reposuite/linux-x64` native package
- `setup/doctor/pair/start/stop/status/update/rollback/uninstall` user-service lifecycle
- Versioned runtime dir + atomic `current` activation; safe update defer on live sessions
- Protected invite pairing (`-invite-file`); systemd --user units; no sudo
- Public identity + dual licensing (MIT CLI / proprietary binaries)
- Release pipeline: prepare/build/package/verify/publish/smoke + OIDC CI

## 0.2.0 — historical
## 0.1.0 — historical

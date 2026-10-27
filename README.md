# RepoSuite

*Your machines. Your projects. Your AI agents. One control plane.*

RepoSuite is a cloud-managed AI development platform connecting your
computers, projects, and AI agents into one workspace. The `reposuite`
CLI installs and manages the local RepoSuite runtime — Gateway (local
project authority over a private Unix socket), Relay (structured native
agent sessions), and the Connector (outbound-only WSS link to RepoSuite
Control) — as ordinary per-user systemd services. No root, no inbound
ports.

## Install

```bash
npm install -g reposuite          # or reposuite@beta
```

## Get started

```bash
reposuite setup                   # install versioned runtime + user services
reposuite doctor                  # readiness checks
reposuite pair                    # pair this machine (invite from the Web Admin — protected input, never argv)
reposuite status                  # service + pairing + activation state
```

Bind a project checkout for agent execution:

```bash
reposuite-gateway project bind-workspace --project <key> --path /abs/checkout --agent-exec true
```

## Update / rollback

```bash
npm update -g reposuite
reposuite update apply            # activates the installed version — defers while agent sessions run
reposuite rollback                # re-activate the previous runtime version
```

## Services

Three `systemd --user` units: `reposuite-rsg`, `reposuite-rsr`,
`reposuite-connector`. Enable user lingering for boot persistence
(`loginctl enable-linger $USER`). State lives under
`~/.local/share/reposuite*` and `~/.reposuite` — preserved across
upgrades and `uninstall` unless `purge-state` is run explicitly.

## Platforms

Linux x64 (Ubuntu 22.04+) — first supported platform.

## Links

- Web Admin / Control: https://app.reposuite.com
- Issues: https://github.com/reposuite/reposuite/issues
- Updating: UPDATING.md · Releasing: RELEASING.md

## License

CLI + packaging: MIT. Native platform binaries: proprietary (see LICENSE.md).

## Architecture note

`bin/reposuite.js` is the single canonical `reposuite` CLI. A future
compiled Rust CLI may be shipped as a native payload inside the platform
package (`packages/linux-x64/bin/`) — the JS file then delegates to it —
but there is only ever ONE user-facing `reposuite` command; no competing
implementations exist in this repository.

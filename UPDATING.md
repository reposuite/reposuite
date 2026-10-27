# Updating RepoSuite

```bash
reposuite update check     # installed vs npm latest
npm update -g reposuite    # fetch the new package
reposuite update apply     # activate — defers while agent sessions run
```

Upgrades preserve state: projects, Gateway identity, credentials,
transcripts and Relay sessions live under `~/.local/share/reposuite*` and
`~/.reposuite` — outside the versioned runtime. The systemd units always
point at the activated `current` symlink, so an npm replacement can never
leave a running service pointing at deleted paths.

```bash
reposuite rollback         # re-activate the previous runtime version
reposuite uninstall        # remove units + activation; state preserved
reposuite purge-state      # explicit full state removal
```

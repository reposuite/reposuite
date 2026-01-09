# reposuite

Developer toolkit for repo navigation, task automation, and browser control.

## Install

```bash
npm i -g reposuite
```

## Usage

```bash
reposuite --help
```

## Supported platforms

- macOS: amd64, arm64
- Linux: amd64, arm64
- Windows: amd64, arm64

## Notes

RepoSuite downloads platform-specific binaries from GitHub Releases during install.
To install a specific release, set `REPOSUITE_VERSION` (example: `v1.2.3`).

For local testing with a packaged tarball that bundles assets:
```bash
npm i -g ./reposuite-<version>.tgz
```

Optional alias (print-only, no auto changes):

```bash
alias rp="reposuite"
```

## Troubleshooting

If installation fails with a download error, check that GitHub Releases are reachable from your network and try reinstalling:

```bash
npm i -g reposuite
```

You can validate the installer flow without downloads:

```bash
npm run smoke:install
```

# Release checklist

1. Tag the private Go repo with the release version.
2. Confirm binaries are uploaded to GitHub Releases under `vX.Y.Z`.
3. Bump npm wrapper version in `package.json`.
4. Run `npm pack` and validate contents.
5. Run `npm publish`.
6. Verify with `npm view reposuite` and install test.
7. Optionally run `npm run smoke:install` to validate installer scaffolding.
8. If testing a specific release asset, set `REPOSUITE_VERSION=vX.Y.Z` before install.

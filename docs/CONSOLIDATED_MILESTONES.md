# RepoSuite consolidated milestones

This is the local execution record, not proof of deployment. Update it as
revisions and independent live evidence become available.

| Milestone | Status | Evidence and remaining gates |
| --- | --- | --- |
| Gateway lifecycle and pairing | IN_PROGRESS | CODE_READY and TEST_VERIFIED locally. Control source `reposuite-gw`, `feature/browser-pairing-v2`, `456e15f34fb889c0ff8886ea34f8ca809e29bc94`; frontend `reposuite-control`, `feature/browser-pairing-web`, `dc933eb94116b72973d5e126772309bd3e4c6ff9` plus a staged fail-closed key-availability fix (commit blocked by missing `scripts/pre-commit` hook target); Gateway `feature/browser-pairing`, `134d4c8f0cd1418846356c740c9c6a815c88b784`. Store/WSS/MCP/OAuth/Web race and Gateway suite passed locally; legacy frontend check and build pass with staged fix. Neither deployment of these revisions nor end-to-end live pairing is verified. |
| WORK setup | IN_PROGRESS | CODE_READY and TEST_VERIFIED candidate `0.3.0-beta.4`, distribution `feature/browser-pairing` source `330fe08e38a18c809cfb09c7e22ecd719189ae57`; Gateway `134d4c8f0cd1418846356c740c9c6a815c88b784`; Relay `0aa45414668ca03a7abd8f1a1a0d80ae35ce8137`. Two clean builds match byte-for-byte; archive verification, isolated offline install, lifecycle fault injection and release tests passed. Not published, transferred, deployed on WORK, or live verified. Follow `handoff/WORK_BETA4_CANDIDATE.md`; Owner approves pairing and supplies WORK evidence. |
| UI_FOUNDATION_READY | IN_PROGRESS | CODE_READY and TEST_VERIFIED candidate `@reposuite/ui` `0.1.0`, `feature/shared-ui-v1`, `4c0cc7b163dadd5b7939bd682e61e27773014595`. Frozen design check, Svelte check, package build/publint, packed consumer build and Chromium desktop/mobile interaction tests passed. Both local App and Admin consume that exact commit using a local Git mirror. The commit is not pushed or published; remote installation is not verified. |
| CUSTOMER_APP_READY | IN_PROGRESS | CODE_READY locally: `reposuite-app`, `feature/customer-app-extraction`, `89e2e8f4b5720dd7de80b36ac4bf41e8400a6903`, shared UI `0.1.0` at `4c0cc7b163dadd5b7939bd682e61e27773014595`. Frozen lockfile install, typecheck, build and five browser tests against mock API passed, including fail-closed pairing availability, CSRF headers and consent form fields. This does not prove backend authorization, real cookies, OAuth, or live pairing. Private Git access and container build remain unverified; no deployment, rollback rehearsal or live HOME check has occurred. |
| ADMIN_ACCESS_READY | IN_PROGRESS | Cloudflare Access application and one allow policy created and read back successfully for `admin.reposuite.com` only; the existing email OTP identity provider is selected, the allowlist contains only `therceman@gmail.com`, and session duration is 24 hours. The `admin.reposuite.com` DNS record is absent, so no live OTP challenge or origin-bypass check is possible yet. App and API DNS records remain proxied; no DNS changes were made. Owner must personally test OTP after a protected Admin origin is deployed. |
| PLATFORM_ADMIN_FOUNDATION_READY | IN_PROGRESS | Local placeholder `reposuite-admin`, `feature/platform-admin-foundation`, `a1478a60a923f0353ccc12c84e90adbdaf39fc1d`, shared UI `0.1.0` at `4c0cc7b163dadd5b7939bd682e61e27773014595`. Frozen lockfile install, typecheck, build and two browser tests pass. Local uncommitted Control changes on `feature/browser-pairing-v2` add a role probe requiring a live session and explicit role, plus trusted-console grant/revoke with durable audit; Go full suite and targeted race tests pass. No role has been granted in production, and no privileged browser operations, platform data or Admin API integration exist yet. Admin deployment, protected origin, host-only session/CSRF contract, authorized views, and cross-account isolation tests remain required. |
| LEGACY_WEB_ADMIN_REMOVED | IN_PROGRESS | Intentionally retained in `reposuite-server/web-admin` until customer and admin deployments, authentication/OAuth/connection smoke tests, rollback and live verification all pass. |

## Deployment and risks

- Earlier work reported Control `d64fcba` and frontend `6d1073c` as deployed;
  exact deployed artifact identity and current routing were not independently
  verified in this milestone. Do not infer deployment of newer local commits.
- `reposuite-control-target` is a separate repository at
  `4110218d2ce66216670184d6ae7e03f7e57a98fa`, not the operational backend.
  Backend migration remains open; no authority moves to the frontend.
- GitHub Customer Auth status is CONFIG_REGISTERED, not IMPLEMENTED. Owner
  handoff is in the canonical Control repository `main` at
  `4110218d2ce66216670184d6ae7e03f7e57a98fa`, pushed to origin. GitHub
  registration has not been independently checked. The local secret reference
  exists, but server-side provisioning and OAuth integration remain pending.
- Legacy local secrets were copied into the rootless local store: 13 values and
  8 aliases were verified without printing values, using `edge-infra`
  `docs/helsinki-rebuild-readiness` at `d521c1b51a8585f2e7c1752433641d2061386c73`.
  The legacy DB and backup remain because the existing env resolver and VPS
  backup/restore still use them. The import is a snapshot, not ongoing sync;
  no production consumer was switched. Local legacy directory/file permissions
  were restricted to the owner. Targeted migration tests pass; `make env_test`
  has one unrelated existing nginx-template assertion failure.
- The Gateway runtime requires `libsqlite3.so.0` and compatible glibc. A
  minimal Debian container without SQLite could not start it; WORK must pass
  the handoff preflight. The static CLI itself starts there.
- No WORK host, active HOME services, credentials or existing registrations
  were changed for this candidate. Live WORK pairing, Devin ACP
  `swe-2-high`, and SGS Lead transfer await the Owner/WORK operator.
- Browser tests needed unprivileged temporary copies of four missing shared
  libraries on this host; no system packages were installed.
- The approved repository boundaries and current audit limitations are
  recorded in `UI_CONTROL_OWNERSHIP_ADR.md`; durable audit and platform
  authorization remain implementation gates, not completed capabilities.

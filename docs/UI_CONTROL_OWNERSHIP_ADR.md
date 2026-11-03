# UI and Control ownership decision

Status: records the Owner-approved UI architecture v2; implementation and
cutover remain in progress. This does not grant deployment authority or
introduce a new planning cycle.

## Decision

- `reposuite-ui` owns the reusable, versioned presentation foundation.
  Customer and platform workflows, API clients, auth and routing stay out.
- `reposuite-app` owns the customer dashboard; `reposuite-admin` owns the
  platform application. Both pin the same actual UI package independently.
- `reposuite-control` owns authentication, authorization, persistence,
  pairing, OAuth, MCP, Gateway connections and audit. Frontend visibility
  and Cloudflare Access do not confer backend authority.
- Edge owns ingress and deployment. Browser API calls prefer same-origin
  routing and host-only cookies, without broad CORS or shared-domain cookies.
  Gateway WSS, MCP and OAuth protocol compatibility remains mandatory.
- Retain legacy `web-admin` until real deployments, workflow smoke tests and
  rollback have passed. Never treat a local build as cutover evidence.

## Audit and platform limits at the local source pin

At Control source `456e15f34fb889c0ff8886ea34f8ca809e29bc94`, the existing
JSON store records sanitized audit rows (`at`, `actor`, `action`, `subject`,
`detail`). The generic `Store.Log` path keeps a bounded 2,048-row tail and
flushes in a throttled window: a crash can lose buffered rows and flush errors
must not be treated as success. It is not an immutable or complete security
ledger. Some transactional operations append audit through separate store
mutations, so the generic log's bound and flush behavior must not be assumed
to describe every append path.

Gateway revoke has a dedicated transactional mutation that saves the revoke
and its existing-RSC audit record together; local tests cover reopening and
write failure. This is not proof of live deployment or a general durability
guarantee for unrelated audit operations.

The local Admin placeholder supplies no platform data or privileged API.
Before exposing real views, Control must implement and test explicit
server-side `platform_admin` authorization and account isolation. Account
Owner endpoints must not be repurposed as platform-wide APIs. Future durable
audit work builds on the existing Control audit authority; it must not create
a competing event system or claim completeness before its retention,
durability and access controls are implemented and verified.

## Verification and rollback

See `CONSOLIDATED_MILESTONES.md` for exact revisions, tests, deployment status
and remaining gates. Preserve a known-good legacy artifact and routing rollback
through the eventual cutover; verify login/logout, CSRF, pairing, OAuth, WSS,
MCP and HOME on the actual deployed revisions before removing old ownership.

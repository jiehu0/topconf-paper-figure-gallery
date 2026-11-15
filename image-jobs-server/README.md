# BERO image jobs

Node.js 24 adapter for the upstream MIT-licensed `infistar-image-relay/worker.mjs`.
The task state machine, provider formats, image validation and no-resubmit rules
remain shared with the Worker. SQLite replaces Durable Object storage/alarms;
ordinary server HTTPS replaces Browser Run. No Cloudflare Worker is required.

The existing 1Panel website still proxies to `127.0.0.1:8094`. Its Caddy service
forwards `/api/image-jobs/*` to the private `image-jobs:8081` container, removing
`/api/image-jobs`. No additional host port is published. The browser's task base
is configured in `forge/deployment-config.js`.

Run `node image-jobs-server/server.mjs` with a persistent `JOB_DATA_DIR`,
`ALLOWED_ORIGINS=https://paper.boyweb.net`, and optionally comma-separated
`IMAGE_JOB_HOSTS` (defaults to `api.shuaiapi.com`). Standard OpenAI, Infistar and
NoneLinear routes are also supported. Custom routes are restricted to HTTPS
`/v1/images/generations` and `/v1/images/edits` on configured hosts.

The data directory contains SQLite state and a randomly generated 0600
`encryption.key`. Keep both together when backing up; do not rotate this key
while records exist. Keys, requests and results are encrypted at rest. Request
headers, keys and prompts are not logged. Results expire after 24 hours while
small replay-prevention tombstones remain. After an interrupted claimed request,
the result is unknown: it is never submitted a second time automatically.

For this deployment only, unacknowledged placeholders from the former backend
are archived in browser localStorage because that backend rejected this origin's
preflight. Confirmed jobs are never migrated into new submissions. Form content,
uploaded references and version history are not cleared by the migration.

Validation (no paid requests):

```
node --test image-jobs-server/test-server.mjs forge/test-step3-infistar-job.mjs forge/test-step3-image-protocol.mjs infistar-image-relay/test-worker.mjs infistar-image-relay/test-image-result.mjs
node forge/test-step3-image-recovery-browser.cjs
```

Before switching the existing release, back up compose/Caddy configuration,
stage a separate source release, validate Caddy syntax, start the private task
service and check `/healthz`. Then reload the Caddy configuration and recreate
the gallery container with the new release. Keep the previous release and
configuration for rollback. Do not modify 1Panel's OpenResty site or public ports.

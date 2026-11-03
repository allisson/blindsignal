# Cloud Run deployment

**Status:** accepted

Phase 10 asks for Cloud Run deployment to be documented, and spec §14.3 names Cloud Run as the
managed host. The server already accounts for it: a maximum connection lifetime under the request
timeout (ADR 0029), a cap per instance under the platform's concurrency (ADR 0030), a shutdown
within its 10-second grace period (ADR 0031), and OTLP for the metrics it does not scrape
(ADR 0038). What remained was the configuration that ties them to Cloud Run, in
`docs/cloud-run.md`.

## Rules

- **The production image runs unchanged** (ADR 0033), pushed to Artifact Registry; no code or image
  specific to Cloud Run.
- **`--timeout=3600` with `BLINDSIGNAL_MAX_CONNECTION_SECONDS=3300`, and `--concurrency=1000` with
  `BLINDSIGNAL_MAX_CONNECTIONS=1000`.** The shutdown defaults already fit the grace period.
- **Without PostgreSQL and Redis, `--max-instances=1`:** the in-memory adapters are not shared, and
  Cloud Run adds instances under load.
- **`--no-cpu-throttling`,** so the device sweep, the registry sync, and OTLP pushes run while no
  client is connected.
- **The registry is a Secret Manager secret mounted as a file, referenced by version number.** The
  server reads it at startup only, and Cloud Run reads a mounted secret on every access: with
  `latest`, instances of one revision could load different registries. A registry change is a new
  version and a new revision. Secrets the server takes as variables go through Secret Manager too
  (ADR 0034).
- **Migrations run as a Cloud Run job with the same image** before each release (ADR 0019).
- **`BLINDSIGNAL_TRUSTED_PROXIES` stays unset until measured.** Google documents neither the peer
  address a container sees nor the front end's `X-Forwarded-For` layout; trusting every address
  would let a client choose its IP for the per-IP limits.

## Considered options

- **Deploying to a test project to verify the guide.** Deferred: it needs a Google Cloud project
  apart from any production one. The guide says it is untested and lists what a deployment settles.
- **The registry baked into a derived image.** Rejected: a second image per registry change, and
  the registry copied into every image repository.
- **The registry in a Cloud Storage volume.** Rejected: one more service and IAM binding for one
  small file.
- **Session affinity.** Not needed: with Redis, any instance serves a reconnect, and without it
  there is one instance.
- **A default `min-instances` of 0.** Rejected as the example: it costs nothing idle, but every
  reconnect after the last client leaves meets a cold start. The guide notes the trade.

## Consequences

- Platform facts come from Google's documentation as read on 2026-11-03, and the image was run
  locally with the guide's settings; nothing has run on Cloud Run.
- Until the client IP is measured, every client may share one address for the per-IP limits of
  ADR 0011.
- TURN cannot run on Cloud Run, which serves HTTP only: it stays on a host of its own.
